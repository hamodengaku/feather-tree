import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandLog, DEFAULT_SETTINGS, SessionManager, type AppSettings } from '@feathertree/core';
import { createService, type Service } from '../src/handlers/service.js';

const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/main-service-tests');
const GIT_PATH = process.env['FT_TEST_GIT'] ?? 'git';

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(GIT_PATH, [...args], { cwd, shell: false, windowsHide: true, stdio: 'ignore' });
    child.on('error', rej);
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`git failed: ${String(code)}`))));
  });
}

/**
 * UI が実際に通る経路（service）を、Electron を起動せずに実リポジトリで検証する。
 * register.ts は ipcMain とこのサービスを繋ぐだけなので、ここを通れば縦の流れが通る。
 */
describe('Service (UI が通る経路の統合テスト)', () => {
  let dir: string;
  let service: Service;
  let commandLog: CommandLog;
  let settings: AppSettings;
  let pickResult: string | null;
  let opened: string[] = [];
  let shownInFolder: string[] = [];
  let openPathFailure = '';
  let launched: { exe: string; args: string[]; cwd: string }[] = [];
  /** locateTerminal の答えを差し替える。null なら「開けるものが無い」。 */
  let terminal: { exe: string; args: readonly string[] } | null = { exe: 'wt.exe', args: [] };

  beforeEach(async () => {
    dir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(dir, { recursive: true });
    await git(dir, ['init', '--initial-branch=main']);
    await git(dir, ['config', 'user.name', 'T']);
    await git(dir, ['config', 'user.email', 't@example.invalid']);

    commandLog = new CommandLog();
    settings = DEFAULT_SETTINGS;
    pickResult = dir;
    opened = [];
    shownInFolder = [];
    openPathFailure = '';
    launched = [];
    terminal = { exe: 'wt.exe', args: [] };

    const sessions = new SessionManager({
      gitPath: GIT_PATH,
      tempDir: join(dir, '.ft-tmp'),
      commandLog,
      settings: () => settings,
    });

    service = createService({
      appInfo: () => ({
        appVersion: '0.0.0',
        electronVersion: '44',
        chromeVersion: '144',
        nodeVersion: '24',
        userDataDir: dir,
        isPackaged: false,
      }),
      git: () => ({ gitPath: GIT_PATH, source: 'path' }),
      gitVersion: () => null,
      settings: () => settings,
      updateSettings: (patch) => {
        settings = { ...settings, ...patch } as AppSettings;
        return Promise.resolve(settings);
      },
      reloadGit: () => Promise.resolve(),
      sessions: () => sessions,
      commandLog: () => commandLog,
      pickDirectory: () => Promise.resolve(pickResult),
      openPath: (absolutePath: string) => {
        opened.push(absolutePath);
        return Promise.resolve(openPathFailure);
      },
      showItemInFolder: (absolutePath: string) => {
        shownInFolder.push(absolutePath);
      },
      resolveTerminal: () => Promise.resolve(terminal),
      launchTerminal: (launch, cwd) => {
        launched.push({ exe: launch.exe, args: [...launch.args], cwd });
      },
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });

  async function write(rel: string, content: string): Promise<void> {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  async function openDemo(): Promise<string> {
    await write('README.md', 'v1');
    await write('Assets/config.json', 'base');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('README.md', 'v2');
    await write('Assets/config.json', 'changed');
    await write('新規ファイル.txt', 'untracked');
    const session = await service.sessionOpen(dir);
    return session.id;
  }

  it('フォルダ選択からリポジトリを開ける', async () => {
    const opened = await service.sessionPickAndOpen();
    expect(opened).not.toBeNull();
    expect(opened?.displayName.length).toBeGreaterThan(0);
    expect(service.sessionList().sessions).toHaveLength(1);
    // 開いたリポジトリが設定に残る（次回起動で復元される）
    expect(settings.openRepositories).toHaveLength(1);
  });

  it('選択がキャンセルされたら null を返す', async () => {
    pickResult = null;
    expect(await service.sessionPickAndOpen()).toBeNull();
    expect(service.sessionList().sessions).toHaveLength(0);
  });

  it('変更一覧をグループごとにページングで取得できる', async () => {
    const id = await openDemo();

    const summary = service.statusGetSummary(id);
    expect(summary.hasSnapshot).toBe(true);
    expect(summary.head?.branch).toBe('main');
    expect(summary.counts.unstaged).toBe(2);
    expect(summary.counts.untracked).toBe(1);

    const changes = service.statusGetPage(id, { offset: 0, limit: 50, filter: { group: 'changes' } });
    expect(changes.filteredTotal).toBe(3);
    expect(changes.entries.map((e) => e.path).sort()).toEqual([
      'Assets/config.json',
      'README.md',
      '新規ファイル.txt',
    ]);
  });

  it('変更 → ステージ → コミットが完結する（Phase 5 の DoD）', async () => {
    const id = await openDemo();

    // 1. すべてステージ（範囲指定でパス配列を送らない）
    const staged = await service.stage(id, { kind: 'filtered', filter: { group: 'changes' } });
    expect(staged.affected).toBe(3);
    expect(service.statusGetSummary(id).counts.staged).toBe(3);

    // 2. 1 件だけステージから戻す
    await service.unstage(id, { kind: 'paths', paths: ['README.md'] });
    expect(service.statusGetSummary(id).counts.staged).toBe(2);

    // 3. 差分を確認できる
    const diff = await service.diffGet(id, 'README.md', false);
    expect(diff?.hunks.length).toBeGreaterThan(0);

    // 4. コミットする
    const result = await service.commit(id, { message: '日本語のコミット\n\n本文', amend: false });
    expect(result.oid).toMatch(/^[0-9a-f]{40}$/);

    // 5. 履歴に現れる
    const log = await service.logGetPage(id, 0);
    expect(log[0]?.subject).toBe('日本語のコミット');

    /*
     * 6. ブランチ一覧の件名も新しくなっている
     *    （対応表の例外「コミット後の反映: #10 → #2 → #3」）。
     *    #3 を取り直さないと、ブランチペインの「現在の位置」とリポジトリタブに
     *    1 つ前の件名が残る。#2 は件名を持たないので、ここが唯一の出所。
     */
    const head = service.branchList(id).find((b) => b.isHead);
    expect(head?.subject).toBe('日本語のコミット');

    // 6. 残りは未ステージのまま
    const after = service.statusGetSummary(id);
    expect(after.counts.staged).toBe(0);
    expect(after.counts.unstaged).toBe(1);
  });

  it('未確認の破棄は needs-confirmation で拒否される', async () => {
    const id = await openDemo();

    await expect(service.discard(id, { kind: 'paths', paths: ['README.md'] })).rejects.toMatchObject({
      dto: { kind: 'needs-confirmation' },
    });

    // ファイルは変更されていない
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('v2');
  });

  it('確認済みなら破棄が実行される', async () => {
    const id = await openDemo();

    const result = await service.discard(id, { kind: 'paths', paths: ['README.md'] }, true);

    expect(result.affected).toBe(1);
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('v1');
  });

  it('未追跡削除も確認が必須で、確認後に削除される', async () => {
    const id = await openDemo();

    await expect(
      service.deleteUntracked(id, { kind: 'filtered', filter: { group: 'untracked' } }),
    ).rejects.toMatchObject({ dto: { kind: 'needs-confirmation' } });
    await expect(stat(join(dir, '新規ファイル.txt'))).resolves.toBeTruthy();

    await service.deleteUntracked(id, { kind: 'filtered', filter: { group: 'untracked' } }, true);
    await expect(stat(join(dir, '新規ファイル.txt'))).rejects.toThrow();
  });

  it('amend は確認が必須', async () => {
    const id = await openDemo();
    await service.stage(id, { kind: 'all' });
    await service.commit(id, { message: '最初', amend: false });
    await write('README.md', 'v3');
    await service.stage(id, { kind: 'all' });

    await expect(service.commit(id, { message: '修正', amend: true })).rejects.toMatchObject({
      dto: { kind: 'needs-confirmation' },
    });

    await service.commit(id, { message: '修正後', amend: true }, true);
    const log = await service.logGetPage(id, 0);
    // openDemo() の init コミット + amend 後の 1 件
    expect(log).toHaveLength(2);
    expect(log[0]?.subject).toBe('修正後');
  });

  it('空のコミットメッセージを拒否する', async () => {
    const id = await openDemo();
    await service.stage(id, { kind: 'all' });
    await expect(service.commit(id, { message: '   ', amend: false })).rejects.toMatchObject({
      dto: { kind: 'internal' },
    });
  });

  it('ブランチを切り替えると HEAD と status が更新される（対応表 #12 → #2）', async () => {
    const id = await openDemo();
    await service.stage(id, { kind: 'all' });
    await service.commit(id, { message: 'init', amend: false });
    await git(dir, ['branch', 'feature']);

    const result = await service.branchSwitch(id, 'feature');

    expect(service.statusGetSummary(id).head?.branch).toBe('feature');
    expect(service.statusGetSummary(id).seq).toBe(result.statusSeq);
  });

  it('未コミットの変更が上書きされる切替は失敗する', async () => {
    const id = await openDemo();
    await service.stage(id, { kind: 'all' });
    await service.commit(id, { message: 'init', amend: false });
    await git(dir, ['branch', 'feature']);
    await git(dir, ['switch', 'feature']);
    await write('README.md', 'feature v1');
    await git(dir, ['commit', '-am', 'feature change']);
    await git(dir, ['switch', 'main']);
    await write('README.md', 'uncommitted');

    await expect(service.branchSwitch(id, 'feature')).rejects.toMatchObject({ name: 'GitCommandError' });
  });

  it('ブランチを作成すると起点から分岐して切り替わる（対応表 #14 → #2、push はしない）', async () => {
    const id = await openDemo();
    await service.stage(id, { kind: 'all' });
    await service.commit(id, { message: 'init', amend: false });

    const result = await service.branchCreate(id, { name: 'obana/topic', startPoint: 'main' });

    expect(service.statusGetSummary(id).head?.branch).toBe('obana/topic');
    expect(service.statusGetSummary(id).seq).toBe(result.statusSeq);
    // 作成後は status のみ再取得する設計なので、branch 一覧はここではまだ古いまま
    // （更新ボタン相当の full refresh で初めて反映される）
    expect(service.branchList(id).find((b) => b.shortName === 'obana/topic')).toBeUndefined();
    await service.sessionRefresh(id, 'full');
    const feature = service.branchList(id).find((b) => b.shortName === 'obana/topic');
    expect(feature?.isHead).toBe(true);
    expect(feature?.oid).toBe(service.branchList(id).find((b) => b.shortName === 'main')?.oid);

    // push していない: commandLog に push が一切記録されていない
    expect(service.commandLogRecent(500).some((e) => e.args[0] === 'push')).toBe(false);
  });

  it('マージは確認が必須で、確認後に取り込まれる（対応表 #35 → #2 → #3）', async () => {
    const id = await openDemo();
    await service.stage(id, { kind: 'all' });
    await service.commit(id, { message: 'init', amend: false });
    await service.branchCreate(id, { name: 'topic', startPoint: 'main' });
    await write('topic.txt', 'from topic');
    await service.sessionRefresh(id, 'status');
    await service.stage(id, { kind: 'all' });
    await service.commit(id, { message: 'topic work', amend: false });
    await service.branchSwitch(id, 'main');

    await expect(service.branchMerge(id, 'topic')).rejects.toMatchObject({
      dto: { kind: 'needs-confirmation' },
    });

    const result = await service.branchMerge(id, 'topic', true);

    expect(service.statusGetSummary(id).seq).toBe(result.statusSeq);
    // fast-forward で main が topic に追いつく。
    // 切替・作成と違い、マージはブランチ一覧も取り直すので full refresh 抜きで新しい oid が見える
    const branches = service.branchList(id);
    expect(branches.find((b) => b.shortName === 'main')?.oid).toBe(
      branches.find((b) => b.shortName === 'topic')?.oid,
    );
  });

  it('ファイルを OS 既定のアプリで開く（絶対パスに直して渡す）', async () => {
    const id = await openDemo();

    await service.shellOpenPath(id, 'README.md');

    expect(opened).toEqual([join(dir, 'README.md')]);
  });

  it('エクスプローラでファイルを選択した状態で開く', async () => {
    const id = await openDemo();

    await service.shellShowInFolder(id, 'README.md');

    expect(shownInFolder).toEqual([join(dir, 'README.md')]);
  });

  it('開けなかったら理由つきで失敗する（openPath は throw しない）', async () => {
    const id = await openDemo();
    openPathFailure = '関連付けられたアプリがありません';

    await expect(service.shellOpenPath(id, 'README.md')).rejects.toMatchObject({
      dto: { kind: 'not-found', detail: '関連付けられたアプリがありません' },
    });
  });

  it('リポジトリ外のパスは開かない', async () => {
    const id = await openDemo();

    // assertInsideRoot が PathOutsideRootError を投げ、register の wrap が invalid-path に写す
    await expect(service.shellOpenPath(id, '../outside.txt')).rejects.toMatchObject({
      name: 'PathOutsideRootError',
    });
    await expect(service.shellShowInFolder(id, 'C:/Windows/system32/cmd.exe')).rejects.toThrow();
    expect(opened).toEqual([]);
  });

  it('マージ対象が空なら拒否する', async () => {
    const id = await openDemo();
    await service.stage(id, { kind: 'all' });
    await service.commit(id, { message: 'init', amend: false });

    await expect(service.branchMerge(id, '  ', true)).rejects.toMatchObject({
      dto: { kind: 'internal' },
    });
  });

  it('新しいブランチ名が空なら拒否する', async () => {
    const id = await openDemo();
    await service.stage(id, { kind: 'all' });
    await service.commit(id, { message: 'init', amend: false });

    await expect(service.branchCreate(id, { name: '   ', startPoint: 'main' })).rejects.toMatchObject({
      dto: { kind: 'internal' },
    });
  });

  it('同名のブランチを作成しようとすると失敗する', async () => {
    const id = await openDemo();
    await service.stage(id, { kind: 'all' });
    await service.commit(id, { message: 'init', amend: false });
    await git(dir, ['branch', 'feature']);

    await expect(service.branchCreate(id, { name: 'feature', startPoint: 'main' })).rejects.toMatchObject({
      name: 'GitCommandError',
    });
  });

  it('リポジトリ外のパスを拒否する', async () => {
    const id = await openDemo();
    await expect(service.stage(id, { kind: 'paths', paths: ['../outside.txt'] })).rejects.toThrow();
    await expect(service.diffGet(id, 'C:/Windows/system32/cmd.exe', false)).rejects.toThrow();
  });

  it('存在しないタブを拒否する', async () => {
    await expect(service.stage('no-such-id', { kind: 'all' })).rejects.toMatchObject({
      dto: { kind: 'no-session' },
    });
  });

  it('ページの件数上限を超える要求を丸める', async () => {
    const id = await openDemo();
    const page = service.statusGetPage(id, { offset: 0, limit: 999_999 });
    expect(page.entries.length).toBeLessThanOrEqual(1000);
  });

  it('実行ログに操作が記録される（透明性の担保）', async () => {
    const id = await openDemo();
    await service.stage(id, { kind: 'all' });

    const log = service.commandLogRecent(50);
    const args = log.map((e) => e.args[0]);
    expect(args).toContain('add');
    expect(args).toContain('status');
    expect(args).toContain('for-each-ref');
  });

  /*
   * リモート操作（対応表 #22〜#25）の入口の検証。
   *
   * 実際に fetch / push が動くかは packages/git 側で本物のリモート相手に見ている。
   * ここで見るのは **renderer が渡してきた名前を main が鵜呑みにしないこと**。
   */
  /*
   * コミット id は一覧照合ができない（main はページングで渡した分しか知らない）ので形で縛る。
   * ここを緩めると、renderer から「rev として解釈される任意の文字列」を git に渡せてしまう。
   */
  it('コミット id として解釈されうる文字列を拒否する（16 進のみ通す）', async () => {
    const id = await openDemo();

    for (const bad of ['HEAD', 'HEAD~3', 'main', '--upload-pack=calc', '..', 'abc', 'g'.repeat(8)]) {
      await expect(service.commitGetFiles(id, bad)).rejects.toMatchObject({
        dto: { kind: 'internal' },
      });
    }
  });

  it('コミットの差分でも、リポジトリ外のパスは拒否する', async () => {
    const id = await openDemo();
    const log = await service.logGetPage(id, 0);
    const oid = log[0]?.oid ?? '';

    // assertInsideRoot が PathOutsideRootError を投げ、register の wrap が invalid-path に写す
    await expect(service.commitGetDiff(id, oid, '../外.txt')).rejects.toMatchObject({
      name: 'PathOutsideRootError',
    });
    await expect(service.commitGetDiff(id, oid, 'C:/Windows/system32/cmd.exe')).rejects.toThrow();
  });

  it('コミットの変更ファイルと、その diff を取得できる（対応表 #21 / #36）', async () => {
    const id = await openDemo();
    const log = await service.logGetPage(id, 0);
    const oid = log[0]?.oid ?? '';

    const files = await service.commitGetFiles(id, oid);
    expect(files.length).toBeGreaterThan(0);

    const target = files[0]?.path ?? '';
    const diff = await service.commitGetDiff(id, oid, target);
    expect(diff?.path).toBe(target);
    // 過去のコミットからはステージできない
    expect(diff?.hunkStageable).toBe(false);
  });

  it('知らないリモート名は拒否する（renderer の値を鵜呑みにしない）', async () => {
    const id = await openDemo();

    await expect(service.remoteFetch(id, 'どこでもない')).rejects.toMatchObject({
      dto: { kind: 'internal' },
    });
  });

  it('知らないブランチ名へのプッシュは拒否する', async () => {
    // リモート一覧を読むのはタブを開く瞬間だけ（対応表 #1 → #2 → #3 → #4）
    await git(dir, ['remote', 'add', 'origin', 'D:/nowhere.git']);
    const id = await openDemo();

    await expect(
      service.remotePush(id, { remote: 'origin', branch: '存在しない', setUpstream: false }),
    ).rejects.toMatchObject({ dto: { kind: 'internal' } });
  });

  it('リモート一覧は git を動かさずスナップショットから返す', async () => {
    await git(dir, ['remote', 'add', 'origin', 'D:/nowhere.git']);
    const id = await openDemo();

    const before = commandLog.size;
    expect(service.remoteList(id)).toEqual(['origin']);
    expect(commandLog.size).toBe(before);
  });

  /*
   * ターミナル起動（決定 26）。renderer からはセッション id しか来ず、
   * 開く場所も実行ファイルも main が決めることを確かめる。
   */
  it('ターミナルはリポジトリルートで起動する（renderer はパスを渡さない）', async () => {
    const id = await openDemo();

    await service.shellOpenTerminal(id);

    expect(launched).toHaveLength(1);
    expect(launched[0]?.exe).toBe('wt.exe');
    expect(launched[0]?.cwd).toBe(service.sessionList().sessions[0]?.root);
  });

  it('git を実行できるターミナルが無ければ、起動せずエラーにする', async () => {
    const id = await openDemo();
    terminal = null;

    await expect(service.shellOpenTerminal(id)).rejects.toMatchObject({
      dto: { kind: 'git-not-found' },
    });
    expect(launched).toHaveLength(0);
  });

  it('タブを閉じると設定からも消える', async () => {
    const id = await openDemo();
    expect(settings.openRepositories).toHaveLength(1);

    await service.sessionClose(id);

    expect(service.sessionList().sessions).toHaveLength(0);
    expect(settings.openRepositories).toHaveLength(0);
  });

  it('タブを並び替えると一覧と設定（再起動用の openRepositories）の両方に反映される', async () => {
    const first = await openDemo();

    const otherDir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(otherDir, { recursive: true });
    await git(otherDir, ['init', '--initial-branch=main']);
    await git(otherDir, ['config', 'user.name', 'T']);
    await git(otherDir, ['config', 'user.email', 't@example.invalid']);
    try {
      const second = (await service.sessionOpen(otherDir)).id;

      await service.sessionReorder([second, first]);

      const reordered = service.sessionList().sessions;
      expect(reordered.map((s) => s.id)).toEqual([second, first]);
      // 再起動時の復元順（openRepositories）も並び替え後の順序に合わせて更新される
      expect(settings.openRepositories).toEqual(reordered.map((s) => s.root));
    } finally {
      await rm(otherDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
  });

  it('git 未検出なら環境情報で案内する', () => {
    const noGit = createService({
      appInfo: () => ({
        appVersion: '0',
        electronVersion: '0',
        chromeVersion: '0',
        nodeVersion: '0',
        userDataDir: '',
        isPackaged: false,
      }),
      git: () => null,
      gitVersion: () => null,
      settings: () => settings,
      updateSettings: () => Promise.resolve(settings),
      reloadGit: () => Promise.resolve(),
      sessions: () => null,
      commandLog: () => commandLog,
      pickDirectory: () => Promise.resolve(null),
      openPath: () => Promise.resolve(''),
      showItemInFolder: () => undefined,
      resolveTerminal: () => Promise.resolve(null),
      launchTerminal: () => undefined,
    });

    const env = noGit.appGetEnvironment();
    expect(env.gitPath).toBeNull();
    expect(env.warning).toContain('Git for Windows');
    expect(noGit.sessionList()).toEqual({ sessions: [], activeId: null });
  });
});
