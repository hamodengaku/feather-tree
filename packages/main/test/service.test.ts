import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandLog, DEFAULT_SETTINGS, SessionManager, type AppSettings } from '@feathertree/core';
import { pathToFileURL } from 'node:url';
import type { CloneProgressEvent } from '@feathertree/ipc';
import { createService, type Service } from '../src/handlers/service.js';

const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/main-service-tests');
const GIT_PATH = process.env['FT_TEST_GIT'] ?? 'git';
/** ssh の解決結果（実在しなくてよい。設定の読み書きしか見ないため）。 */
const SSH_PATH = 'C:' + String.fromCharCode(92) + 'ssh.exe';

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
  /** ファイル選択ダイアログの答え（設定画面の git.exe / SSH 鍵）。 */
  let pickFileResult: string | null;
  let opened: string[] = [];
  let shownInFolder: string[] = [];
  let openPathFailure = '';
  let launched: { exe: string; args: string[]; cwd: string }[] = [];
  /** locateTerminal の答えを差し替える。null なら「開けるものが無い」。 */
  let terminal: { exe: string; args: readonly string[] } | null = { exe: 'wt.exe', args: [] };
  /** renderer へ送ったつもりのクローンの進捗。 */
  let progress: CloneProgressEvent[] = [];
  /** 進捗を受け取るたびに呼ぶ（中止の検証用）。 */
  let onProgress: (event: CloneProgressEvent) => void = () => undefined;

  beforeEach(async () => {
    dir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(dir, { recursive: true });
    await git(dir, ['init', '--initial-branch=main']);
    await git(dir, ['config', 'user.name', 'T']);
    await git(dir, ['config', 'user.email', 't@example.invalid']);

    commandLog = new CommandLog();
    settings = DEFAULT_SETTINGS;
    pickResult = dir;
    pickFileResult = null;
    opened = [];
    shownInFolder = [];
    openPathFailure = '';
    launched = [];
    terminal = { exe: 'wt.exe', args: [] };
    progress = [];
    onProgress = () => undefined;

    const sessions = new SessionManager({
      gitPath: GIT_PATH,
      sshPath: SSH_PATH,
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
      sshPath: () => SSH_PATH,
      settings: () => settings,
      updateSettings: (patch) => {
        settings = { ...settings, ...patch } as AppSettings;
        return Promise.resolve(settings);
      },
      reloadGit: () => Promise.resolve(),
      sessions: () => sessions,
      commandLog: () => commandLog,
      pickDirectory: () => Promise.resolve(pickResult),
      pickFile: () => Promise.resolve(pickFileResult),
      notifyCloneProgress: (event) => {
        progress.push(event);
        onProgress(event);
      },
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

  it('フォルダ選択でタブが立つ。一覧の取得はこの時点ではまだ行わない', async () => {
    const opened = await service.sessionPickAndCreate();
    expect(opened).not.toBeNull();
    expect(opened?.displayName.length).toBeGreaterThan(0);
    expect(service.sessionList().sessions).toHaveLength(1);
    // 開いたリポジトリが設定に残る（次回起動で復元される）
    expect(settings.openRepositories).toHaveLength(1);

    /*
     * タブは立っているが中身はまだ無い。renderer はこの状態のタブを先に見せ、
     * 続く sessionLoad の間だけ回転印を出す（決定 26 / コマンドバー）。
     */
    expect(service.statusGetSummary(opened?.id ?? '').hasSnapshot).toBe(false);
  });

  it('sessionLoad で一覧が入る。二度目は git を実行しない', async () => {
    const opened = await service.sessionPickAndCreate();
    const id = opened?.id ?? '';

    await service.sessionLoad(id);
    expect(service.statusGetSummary(id).hasSnapshot).toBe(true);

    const before = commandLog.size;
    await service.sessionLoad(id);
    expect(commandLog.size).toBe(before);
  });

  it('選択がキャンセルされたら null を返す', async () => {
    pickResult = null;
    expect(await service.sessionPickAndCreate()).toBeNull();
    expect(service.sessionList().sessions).toHaveLength(0);
  });

  /*
   * クローン（対応表 #37 → #1）。クローン元はテスト用リポジトリそのもの（ネットワーク不要）。
   * 保存先は dir の中に作るので、後始末は dir ごと消える。
   */
  describe('クローン', () => {
    async function prepare(): Promise<string> {
      await write('README.md', 'v1');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'init']);
      const parentDir = join(dir, 'clones');
      await mkdir(parentDir, { recursive: true });
      return parentDir;
    }

    it('クローンするとタブが立ち、設定に残り、段階表の進捗が送られる', async () => {
      const parentDir = await prepare();

      const outcome = await service.sessionCloneAndCreate({ url: dir, parentDir, name: 'copy', mode: 'normal' });

      expect(outcome.result).toBe('succeeded');
      const opened = outcome.session;
      expect(opened?.displayName).toBe('copy');
      expect(resolve(opened?.root ?? '')).toBe(resolve(parentDir, 'copy'));
      expect(settings.openRepositories.map((r) => resolve(r))).toContain(resolve(parentDir, 'copy'));
      // 一覧はまだ取らない（2 段目は sessionLoad）
      expect(service.statusGetSummary(opened?.id ?? '').hasSnapshot).toBe(false);

      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every((e) => e.opId.startsWith('clone:') && e.stages.length === 7)).toBe(true);
      expect(outcome.stages).toHaveLength(7);
      expect(commandLog.recent(20).some((e) => e.args[0] === 'clone' && e.exitCode === 0)).toBe(true);
    });

    it('実行中に二重には走らせず、中止すると残りの手順を止めてタブは立てる', async () => {
      const parentDir = await prepare();
      onProgress = (event) => {
        // LFS の確認が始まったら中止する（クローン自体は済んでいる）
        if (event.stages.some((s) => s.id === 'lfs-check' && s.state === 'running')) service.cloneCancel();
      };

      const first = service.sessionCloneAndCreate({ url: pathToFileURL(dir).href, parentDir, name: 'big', mode: 'large' });
      await expect(
        service.sessionCloneAndCreate({ url: dir, parentDir, name: 'other', mode: 'normal' }),
      ).rejects.toMatchObject({ dto: { kind: 'internal' } });

      const outcome = await first;
      expect(outcome.result).toBe('partial');
      expect(outcome.cancelled).toBe(true);
      expect(outcome.session).not.toBeNull();
      expect(outcome.followUps).toContain('git fetch --unshallow');

      // 終わった後の中止は何もしない。次のクローンは走れる
      expect(service.cloneCancel()).toBeNull();
      const next = await service.sessionCloneAndCreate({ url: dir, parentDir, name: 'other', mode: 'normal' });
      expect(next.result).toBe('succeeded');
    });

    it('保存先の選択はフォルダ選択をそのまま返す（git は動かない）', async () => {
      pickResult = 'D:/somewhere';
      const before = commandLog.size;
      expect(await service.clonePickDirectory()).toBe('D:/somewhere');
      expect(commandLog.size).toBe(before);
    });

    it('renderer の入力を検証し、git を動かさずに拒否する', async () => {
      const parentDir = await prepare();
      const base = { url: dir, parentDir, name: 'copy', mode: 'normal' as const };
      const bad = [
        { ...base, url: '   ' },
        { ...base, url: '--upload-pack=evil' },
        { ...base, url: dir + '\nx' },
        { ...base, name: '' },
        { ...base, name: 'a/b' },
        { ...base, name: 'a\\b' },
        { ...base, name: '..' },
        { ...base, name: 'trailing.' },
        { ...base, parentDir: 'relative/dir' },
        { ...base, parentDir: join(dir, 'missing') },
      ];

      const before = commandLog.size;
      for (const req of bad) {
        await expect(service.sessionCloneAndCreate(req)).rejects.toMatchObject({ dto: { kind: 'internal' } });
      }
      expect(commandLog.size).toBe(before);
      expect(service.sessionList().sessions).toHaveLength(0);
    });

    it('空でない既存フォルダへのクローンは失敗の結果（ヒント付き）で返り、タブは立たない', async () => {
      const parentDir = await prepare();
      await mkdir(join(parentDir, 'occupied'), { recursive: true });
      await writeFile(join(parentDir, 'occupied', 'keep.txt'), 'x', 'utf8');

      const outcome = await service.sessionCloneAndCreate({ url: dir, parentDir, name: 'occupied', mode: 'normal' });
      expect(outcome.result).toBe('failed');
      expect(outcome.session).toBeNull();
      expect(outcome.hints[0]?.id).toBe('destination-exists');
      expect(outcome.log).toContain('$ git clone');
      expect(service.sessionList().sessions).toHaveLength(0);
      expect(commandLog.recent(20).some((e) => e.args[0] === 'clone' && e.exitCode !== 0)).toBe(true);
    });
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
     *    #3 を取り直さないと、リポジトリタブに 1 つ前の件名が残る。
     *    #2 は件名を持たないので、ここが唯一の出所。
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
    // main は自分が知っているブランチ一覧としか照合しない（3-B）。
    // git を直接叩いて作った 'feature' を main に見せるには一度取り直す。
    await service.sessionRefresh(id, 'full');

    const result = await service.branchSwitch(id, 'feature');

    expect(service.statusGetSummary(id).head?.branch).toBe('feature');
    expect(service.statusGetSummary(id).seq).toBe(result.statusSeq);
  });

  it('リモートブランチのダブルクリックはローカルへ取り出して切り替える（対応表 #45 → #2 → #3）', async () => {
    const remoteDir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(remoteDir, { recursive: true });
    await git(remoteDir, ['init', '--initial-branch=main']);
    await git(remoteDir, ['config', 'user.name', 'T']);
    await git(remoteDir, ['config', 'user.email', 't@example.invalid']);
    await writeFile(join(remoteDir, 'u.txt'), 'x', 'utf8');
    await git(remoteDir, ['add', '-A']);
    await git(remoteDir, ['commit', '-m', 'upstream init']);
    await git(remoteDir, ['switch', '-c', 'feature/x']);
    await git(remoteDir, ['switch', 'main']);

    try {
      const id = await openDemo();
      await service.stage(id, { kind: 'all' });
      await service.commit(id, { message: 'init', amend: false });
      await git(dir, ['remote', 'add', 'origin', remoteDir]);
      await git(dir, ['fetch', 'origin']);
      await service.sessionRefresh(id, 'full');

      // renderer は一覧に出ている名前そのまま（リモート名つき）を渡す
      const result = await service.branchSwitch(id, 'origin/feature/x');

      expect(result.branchesRefreshed).toBe(true);
      expect(service.statusGetSummary(id).head?.branch).toBe('feature/x');
      // 一覧も取り直しているので、full refresh 抜きで新しいローカル枝が見える
      const local = service.branchList(id).find((b) => !b.isRemote && b.shortName === 'feature/x');
      expect(local?.upstream).toBe('origin/feature/x');

      // 同じ行をもう一度叩くと、今度は既存のローカル枝への切替（#12）になる
      await service.branchSwitch(id, 'main');
      const again = await service.branchSwitch(id, 'origin/feature/x');
      expect(again.branchesRefreshed).toBe(false);
      expect(service.statusGetSummary(id).head?.branch).toBe('feature/x');
    } finally {
      await rm(remoteDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    }
  });

  it('リモート名を落とした名前は受け付けない（renderer が送る名前は一覧の名前そのまま、3-B）', async () => {
    const id = await openDemo();
    await service.stage(id, { kind: 'all' });
    await service.commit(id, { message: 'init', amend: false });

    await expect(service.branchSwitch(id, 'feature/x')).rejects.toMatchObject({
      dto: { kind: 'internal' },
    });
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
    await service.sessionRefresh(id, 'full');

    await expect(service.branchSwitch(id, 'feature')).rejects.toMatchObject({ name: 'GitCommandError' });
  });

  it('知らないブランチ名への切替は拒否する（renderer の値を鵜呑みにしない、3-B）', async () => {
    const id = await openDemo();
    await service.stage(id, { kind: 'all' });
    await service.commit(id, { message: 'init', amend: false });

    await expect(service.branchSwitch(id, 'どこにもない')).rejects.toMatchObject({
      dto: { kind: 'internal' },
    });
  });

  it('先頭が - のブランチ名は切替・作成・マージのいずれも拒否する（3-A / 3-B の argv インジェクション対策）', async () => {
    const id = await openDemo();
    await service.stage(id, { kind: 'all' });
    await service.commit(id, { message: 'init', amend: false });

    await expect(service.branchSwitch(id, '-feature')).rejects.toMatchObject({ dto: { kind: 'internal' } });
    await expect(
      service.branchCreate(id, { name: '-feature', startPoint: 'main' }),
    ).rejects.toMatchObject({ dto: { kind: 'internal' } });
    await expect(
      service.branchCreate(id, { name: 'feature', startPoint: '-main' }),
    ).rejects.toMatchObject({ dto: { kind: 'internal' } });
    await expect(service.branchMerge(id, '-feature', true)).rejects.toMatchObject({
      dto: { kind: 'internal' },
    });
  });

  it('先頭が - のリモート名・ブランチ名でのフェッチ・プッシュは拒否する（3-A）', async () => {
    await git(dir, ['remote', 'add', 'origin', 'D:/nowhere.git']);
    const id = await openDemo();

    await expect(service.remoteFetch(id, '-origin')).rejects.toMatchObject({ dto: { kind: 'internal' } });
    await expect(
      service.remotePush(id, { remote: 'origin', branch: '-main', setUpstream: false }),
    ).rejects.toMatchObject({ dto: { kind: 'internal' } });
  });

  it('ブランチを作成すると起点から分岐して切り替わる（対応表 #14 → #2 → #3、push はしない）', async () => {
    const id = await openDemo();
    await service.stage(id, { kind: 'all' });
    await service.commit(id, { message: 'init', amend: false });

    const result = await service.branchCreate(id, { name: 'obana/topic', startPoint: 'main' });

    expect(service.statusGetSummary(id).head?.branch).toBe('obana/topic');
    expect(service.statusGetSummary(id).seq).toBe(result.statusSeq);
    // 作成後はブランチ一覧も取り直すので、full refresh 抜きで新しい枝が見える
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

  /*
   * 脆弱性診断 §5: 実行されうる拡張子（.exe 等）だけ、main が確認を強制する。
   * resolveShellTarget の realpath 検証の後に判定するため、renderer を迂回した
   * IPC 呼び出し（confirmed を渡さない）でも openPath には到達しない。
   */
  it('実行されうる拡張子は未確認だと needs-confirmation で拒否し、openPath を呼ばない', async () => {
    const id = await openDemo();
    await write('malware.exe', 'dummy');

    await expect(service.shellOpenPath(id, 'malware.exe')).rejects.toMatchObject({
      dto: { kind: 'needs-confirmation' },
    });
    expect(opened).toEqual([]);
  });

  it('実行されうる拡張子でも確認済みなら開く', async () => {
    const id = await openDemo();
    await write('malware.exe', 'dummy');

    await service.shellOpenPath(id, 'malware.exe', true);

    expect(opened).toEqual([join(dir, 'malware.exe')]);
  });

  it('大文字拡張子・複合拡張子（readme.txt.exe）も同じく確認が必須', async () => {
    const id = await openDemo();
    await write('SETUP.EXE', 'dummy');
    await write('readme.txt.exe', 'dummy');

    await expect(service.shellOpenPath(id, 'SETUP.EXE')).rejects.toMatchObject({
      dto: { kind: 'needs-confirmation' },
    });
    await expect(service.shellOpenPath(id, 'readme.txt.exe')).rejects.toMatchObject({
      dto: { kind: 'needs-confirmation' },
    });
    expect(opened).toEqual([]);
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

  /*
   * 診断 Medium 1: ジャンクション（Windows では無権限で作成できる）越しに、文字列上は
   * リポジトリ配下に見えるパスが実体としてリポジトリ外を指せる。shell 系 API の直前でだけ
   * 実体パスを再検証する（assertRealPathInsideRoot）ことを、実際にジャンクションを作って確かめる。
   */
  it('ワークツリー内のジャンクション越しにリポジトリ外を指すパスは開かない', async () => {
    const id = await openDemo();
    const outside = join(TEST_ROOT, 'ft-junction-outside-' + randomBytes(8).toString('hex'));
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'leak', 'utf8');

    const junctionPath = join(dir, 'link');
    await symlink(outside, junctionPath, 'junction');

    try {
      await expect(service.shellOpenPath(id, 'link/secret.txt')).rejects.toMatchObject({
        name: 'PathOutsideRootError',
      });
      await expect(service.shellShowInFolder(id, 'link/secret.txt')).rejects.toMatchObject({
        name: 'PathOutsideRootError',
      });
      expect(opened).toEqual([]);
      expect(shownInFolder).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
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

  /*
   * コミット情報（対応表 #42〜#44）。
   *
   * 値の検証は **main が実質の唯一の防壁**（git config の値は位置引数で、
   * fetch / push のような `--` による守りが効かない）。拒否したときに
   * **git を 1 本も起動していない**ことまで確かめる。
   */
  describe('コミット情報 (対応表 #42〜#44)', () => {
    it('ローカルの設定を読む（fixture は local に設定済み）', async () => {
      const id = await openDemo();
      const identity = await service.gitConfigGetIdentity(id);
      expect(identity.name).toEqual({ value: 'T', scope: 'local' });
      expect(identity.email).toEqual({ value: 't@example.invalid', scope: 'local' });
    });

    it('保存するとローカルに書かれ、読み直すと反映されている', async () => {
      const id = await openDemo();
      await service.gitConfigSetIdentity(id, { name: '新しい名前', email: 'new@example.invalid' });

      const identity = await service.gitConfigGetIdentity(id);
      expect(identity.name).toEqual({ value: '新しい名前', scope: 'local' });
      expect(identity.email).toEqual({ value: 'new@example.invalid', scope: 'local' });
    });

    it('変えるキーだけを送れる（null は変更しない）', async () => {
      const id = await openDemo();
      await service.gitConfigSetIdentity(id, { name: '名前だけ', email: null });

      const identity = await service.gitConfigGetIdentity(id);
      expect(identity.name.value).toBe('名前だけ');
      expect(identity.email.value).toBe('t@example.invalid');
    });

    it('前後の空白は落として保存する', async () => {
      const id = await openDemo();
      await service.gitConfigSetIdentity(id, { name: '  詰めた  ', email: null });
      expect((await service.gitConfigGetIdentity(id)).name.value).toBe('詰めた');
    });

    it('空・先頭が -・制御文字・長すぎる値は拒否し、git を 1 本も起動しない', async () => {
      const id = await openDemo();

      for (const bad of ['', '   ', '-weird', 'a\nb', 'x'.repeat(256)]) {
        const before = service.commandLogRecent(500).length;
        await expect(service.gitConfigSetIdentity(id, { name: bad, email: null })).rejects.toThrow();
        expect(service.commandLogRecent(500).length).toBe(before);
      }

      // 元の値が残っていること
      expect((await service.gitConfigGetIdentity(id)).name.value).toBe('T');
    });

    it('タブが無ければ no-session（git を動かさない）', async () => {
      await expect(service.gitConfigGetIdentity('no-such-id')).rejects.toThrow();
      await expect(
        service.gitConfigSetIdentity('no-such-id', { name: 'x', email: null }),
      ).rejects.toThrow();
    });

    it('読み書きが実行ログに残る（透明性の担保）', async () => {
      const id = await openDemo();
      await service.gitConfigGetIdentity(id);
      await service.gitConfigSetIdentity(id, { name: '記録される', email: null });

      const args = service.commandLogRecent(50).map((e) => e.args.join(' '));
      expect(args).toContain('config user.name');
    });
  });

  describe('設定のパス検証', () => {
    it('絶対パスでない git.exe は拒否する', async () => {
      await expect(service.settingsUpdate({ gitPath: 'git.exe' })).rejects.toThrow();
    });

    it('null（自動探索に戻す）は通す', async () => {
      await expect(service.settingsUpdate({ gitPath: null })).resolves.toBeDefined();
    });

    it('SSH 鍵の辞書は、キーも値も絶対パスでなければ拒否する', async () => {
      await expect(
        service.settingsUpdate({ sshKeyPaths: { 'D:\\repo': '.ssh/id_ed25519' } }),
      ).rejects.toThrow();
      await expect(
        service.settingsUpdate({ sshKeyPaths: { relative: 'C:\\keys\\id_ed25519' } }),
      ).rejects.toThrow();
    });
  });

  /*
   * SSH 鍵はリポジトリごと（決定 13 の 2026-09-19 改定 2）。
   * 「他のリポジトリの登録を巻き添えにしない」ことがこの機能の肝なので、そこを見る。
   */
  describe('SSH 鍵（リポジトリごと）', () => {
    it('アクティブなタブのリポジトリに登録し、null で消す', async () => {
      const id = await openDemo();
      const root = service.sessionList().sessions.find((s) => s.id === id)?.root ?? '';

      const saved = await service.sshSetKey(id, 'C:\\keys\\id_ed25519');
      expect(saved.sshKeyPaths[root]).toBe('C:\\keys\\id_ed25519');

      const cleared = await service.sshSetKey(id, null);
      expect(cleared.sshKeyPaths[root]).toBeUndefined();
    });

    it('他のリポジトリの登録は触らない', async () => {
      const id = await openDemo();
      // 別のリポジトリの登録が先にあるところへ、このリポジトリの鍵を足す
      await service.settingsUpdate({ sshKeyPaths: { 'D:\\other': 'C:\\keys\\other' } });

      const saved = await service.sshSetKey(id, 'C:\\keys\\mine');
      expect(saved.sshKeyPaths['D:\\other']).toBe('C:\\keys\\other');

      const cleared = await service.sshSetKey(id, null);
      expect(cleared.sshKeyPaths['D:\\other']).toBe('C:\\keys\\other');
    });

    it('絶対パスでない鍵は拒否し、タブが無ければ no-session', async () => {
      const id = await openDemo();
      await expect(service.sshSetKey(id, 'id_ed25519')).rejects.toThrow();
      await expect(service.sshSetKey('no-such-id', 'C:\\keys\\a')).rejects.toThrow();
    });

    it('ファイル選択は用途をそのまま deps へ渡す', async () => {
      pickFileResult = 'C:/Users/me/.ssh/id_ed25519';
      expect(await service.dialogPickFile('ssh-private-key')).toBe('C:/Users/me/.ssh/id_ed25519');
      pickFileResult = null;
      expect(await service.dialogPickFile('git-executable')).toBeNull();
    });
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

  it('実行ログの一覧は、どのタブの実行かを sessionId で返す（クローンは null）', async () => {
    const id = await openDemo();
    const parentDir = join(dir, 'clones');
    await mkdir(parentDir, { recursive: true });
    await service.sessionCloneAndCreate({ url: dir, parentDir, name: 'copy', mode: 'normal' });

    const entries = service.commandLogRecent(50);
    expect(entries.filter((e) => e.args[0] === 'status').every((e) => e.sessionId === id)).toBe(true);
    expect(entries.find((e) => e.args[0] === 'clone')?.sessionId).toBeNull();
  });

  it('git 未検出なら環境情報で案内し、クローンは例外にせずヒント付きの失敗で返す', async () => {
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
      sshPath: () => SSH_PATH,
      settings: () => settings,
      updateSettings: () => Promise.resolve(settings),
      reloadGit: () => Promise.resolve(),
      sessions: () => null,
      commandLog: () => commandLog,
      pickDirectory: () => Promise.resolve(null),
      pickFile: () => Promise.resolve(null),
      notifyCloneProgress: () => undefined,
      openPath: () => Promise.resolve(''),
      showItemInFolder: () => undefined,
      resolveTerminal: () => Promise.resolve(null),
      launchTerminal: () => undefined,
    });

    const env = noGit.appGetEnvironment();
    expect(env.gitPath).toBeNull();
    expect(env.warning).toContain('Git for Windows');
    expect(noGit.sessionList()).toEqual({ sessions: [], activeId: null });

    const outcome = await noGit.sessionCloneAndCreate({ url: 'git@github.com:o/r.git', parentDir: dir, name: 'r', mode: 'large' });
    expect(outcome.result).toBe('failed');
    expect(outcome.hints.map((h) => h.id)).toEqual(['git-not-found']);
  });
});
