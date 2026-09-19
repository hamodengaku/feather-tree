import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandLog,
  DEFAULT_SETTINGS,
  SessionManager,
  displayNameOf,
  locateGit,
  type AppSettings,
  type CloneStage,
  type CommandStart,
} from '../src/index.js';

// CLAUDE.md 規約 2: os.tmpdir() は使わずリポジトリ内に閉じる
const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/core-session-tests');
const GIT_PATH = process.env['FT_TEST_GIT'] ?? 'git';

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(GIT_PATH, [...args], { cwd, shell: false, windowsHide: true, stdio: 'ignore' });
    child.on('error', rej);
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`git failed: ${String(code)}`))));
  });
}

describe('RepositorySession / SessionManager', () => {
  let dir: string;
  let manager: SessionManager;
  let commandLog: CommandLog;
  let settings: AppSettings;
  /** コマンドバー向けの「実行中」通知（決定 26）を受け取る器。 */
  let started: CommandStart[];
  let ended: string[];

  beforeEach(async () => {
    dir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(dir, { recursive: true });
    await git(dir, ['init', '--initial-branch=main']);
    await git(dir, ['config', 'user.name', 'T']);
    await git(dir, ['config', 'user.email', 't@example.invalid']);

    commandLog = new CommandLog();
    settings = DEFAULT_SETTINGS;
    started = [];
    ended = [];
    manager = new SessionManager({
      gitPath: GIT_PATH,
      tempDir: join(dir, '.ft-tmp'),
      commandLog,
      settings: () => settings,
      onCommandStart: (event) => started.push(event),
      onCommandEnd: (opId) => ended.push(opId),
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

  it('Electron 無しでリポジトリを開ける（core が electron 非依存である証明）', async () => {
    await write('a.txt', 'x');
    const session = await manager.open(dir);

    expect(session.root.length).toBeGreaterThan(0);
    expect(session.gitDir).toContain('.git');
    expect(session.getStatusSummary().hasSnapshot).toBe(true);
    expect(session.getStatusSummary().counts.untracked).toBe(1);
    expect(session.branches).toHaveLength(0);
    expect(session.remotes).toEqual([]);
  });

  it('コマンドログにはどのタブの実行かが残り、記録のたびに通知される', async () => {
    const notified: string[] = [];
    const unsubscribe = commandLog.onAdd((entry) => notified.push(entry.args[0] ?? ''));

    const session = await manager.open(dir);

    expect(commandLog.recent(20).every((e) => e.scope === session.id)).toBe(true);
    expect(notified.sort()).toEqual(['for-each-ref', 'remote', 'status']);
    unsubscribe();
    await manager.requestStatusRefresh(session.id);
    expect(notified).toHaveLength(3);
  });

  it('open は status / for-each-ref / remote だけを使う（許可された例外）', async () => {
    await manager.open(dir);
    const args = commandLog.recent(20).map((e) => e.args[0]);
    expect(args.sort()).toEqual(['for-each-ref', 'remote', 'status']);
  });

  /*
   * クローン（対応表 #37〜#41 → #1）。セッションが立つ前なので track() を通らない。
   * それでもコマンドログには必ず残す（決定 16 の透明性）。git の失敗・中止は例外にせず結果で返る。
   */
  describe('clone', () => {
    let parentDir: string;
    /** 受け取った段階表のスナップショット。 */
    let snapshots: CloneStage[][];

    beforeEach(async () => {
      await write('a.txt', 'x');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'first']);
      await write('b.txt', 'y');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'second']);
      await git(dir, ['branch', 'feature']);
      parentDir = join(dir, 'clones');
      await mkdir(parentDir, { recursive: true });
      snapshots = [];
    });

    const record = (stages: CloneStage[]): void => {
      snapshots.push(stages);
    };
    const stateOf = (stages: readonly CloneStage[], id: string): string | undefined =>
      stages.find((s) => s.id === id)?.state;

    it('クローンしてルート解決だけ行い、コマンドログに残す', async () => {
      const outcome = await manager.clone({ url: pathToFileURL(dir).href, parentDir, name: 'copy', mode: 'normal' }, record);

      expect(outcome.result).toBe('succeeded');
      const session = outcome.session;
      expect(session).not.toBeNull();
      expect(displayNameOf(session?.root ?? '')).toBe('copy');
      expect(manager.activeId).toBe(session?.id);
      expect(session?.getStatusSummary().hasSnapshot).toBe(false);
      const clones = commandLog.recent(20).filter((e) => e.args[0] === 'clone');
      expect(clones).toHaveLength(1);
      expect(clones[0]?.exitCode).toBe(0);
      expect(clones[0]?.cwd).toBe(parentDir);
      // 実物の git の進捗行で、受信の段階が完了まで進む
      expect(snapshots.length).toBeGreaterThan(1);
      expect(stateOf(outcome.stages, 'clone-receive')).toBe('done');
      expect(outcome.stages.every((s) => s.state !== 'pending' && s.state !== 'running')).toBe(true);
      expect(outcome.log).toContain('$ git clone');
      expect(outcome.followUps).toEqual([]);
      // クローン自体はコマンドバーに映らない（セッションが無い）
      expect(started.some((e) => e.args[0] === 'clone')).toBe(false);
    });

    it('シャローで成功したら、後で打つ推奨コマンド 2 つを返す', async () => {
      const outcome = await manager.clone({ url: pathToFileURL(dir).href, parentDir, name: 'copy', mode: 'shallow' }, record);

      expect(outcome.result).toBe('succeeded');
      expect(outcome.followUps).toHaveLength(2);
      expect(outcome.followUps[1]).toBe('git fetch --unshallow');
    });

    it('失敗してもコマンドログに残り、タブは立たず、ヒントと生ログが返る', async () => {
      const outcome = await manager.clone(
        { url: join(dir, 'nowhere'), parentDir, name: 'copy', mode: 'normal' },
        () => undefined,
      );

      expect(outcome.result).toBe('failed');
      expect(outcome.session).toBeNull();
      expect(outcome.hints.length).toBeGreaterThan(0);
      expect(outcome.log).toContain('終了コード');
      const entry = commandLog.recent(20).find((e) => e.args[0] === 'clone');
      expect(entry?.exitCode).not.toBe(0);
      expect(entry?.stderr).toBeDefined();
      expect(manager.list()).toHaveLength(0);
    });

    it('大規模モードは shallow → lfs version →（lfs pull）→ config → unshallow の順で、全履歴と全ブランチがそろう', async () => {
      const outcome = await manager.clone({ url: pathToFileURL(dir).href, parentDir, name: 'big', mode: 'large' }, record);

      expect(outcome.result).toBe('succeeded');
      const order = commandLog
        .recent(20)
        .reverse()
        .map((e) => e.args.slice(0, 2).join(' '));
      const lfsPulled = order.includes('lfs pull');
      expect(order).toEqual([
        'clone --depth',
        'lfs version',
        ...(lfsPulled ? ['lfs pull'] : []),
        'config remote.origin.fetch',
        'fetch --unshallow',
      ]);
      expect(stateOf(outcome.stages, 'lfs-check')).toBe('done');
      expect(stateOf(outcome.stages, 'config')).toBe('done');
      // 小さな fetch では git が受信の行を出さないことがある。段階が閉じていること（失敗していないこと）を見る
      expect(
        outcome.stages
          .filter((s) => s.group === 'unshallow')
          .every((s) => s.state === 'done' || s.state === 'skipped'),
      ).toBe(true);
      expect(commandLog.recent(20).find((e) => e.args[0] === 'fetch')?.exitCode).toBe(0);
      await expect(stat(join(parentDir, 'big', '.git', 'shallow'))).rejects.toThrow();
      expect(outcome.followUps).toEqual([]);
    });

    it('ローカルパスの URL では --depth が無視されるので、unshallow は打たずに省略にする', async () => {
      const outcome = await manager.clone({ url: dir, parentDir, name: 'local', mode: 'large' }, record);

      expect(outcome.result).toBe('succeeded');
      expect(commandLog.recent(20).some((e) => e.args[0] === 'fetch')).toBe(false);
      expect(outcome.stages.filter((s) => s.group === 'unshallow').every((s) => s.state === 'skipped')).toBe(true);
    });

    it('クローンの途中で中止すると failed（中止）で、タブは立たない', async () => {
      const controller = new AbortController();
      controller.abort();

      const outcome = await manager.clone(
        { url: pathToFileURL(dir).href, parentDir, name: 'stopped', mode: 'large' },
        record,
        controller.signal,
      );

      expect(outcome.result).toBe('failed');
      expect(outcome.cancelled).toBe(true);
      expect(outcome.session).toBeNull();
      expect(outcome.hints[0]?.id).toBe('cancelled');
      expect(outcome.stages.filter((s) => s.group === 'unshallow').every((s) => s.state === 'cancelled')).toBe(true);
    });

    it('クローンが済んだ後に中止すると partial（中止）で、タブは立ち、残りのコマンドを返す', async () => {
      const controller = new AbortController();
      const outcome = await manager.clone(
        { url: pathToFileURL(dir).href, parentDir, name: 'half', mode: 'large' },
        (stages) => {
          // LFS の確認が始まった瞬間に中止する
          if (stateOf(stages, 'lfs-check') === 'running') controller.abort();
        },
        controller.signal,
      );

      expect(outcome.result).toBe('partial');
      expect(outcome.cancelled).toBe(true);
      expect(outcome.session).not.toBeNull();
      expect(outcome.followUps).toContain('git fetch --unshallow');
      expect(stateOf(outcome.stages, 'clone-checkout')).not.toBe('cancelled');
      expect(stateOf(outcome.stages, 'unshallow-receive')).toBe('cancelled');
    });
  });

  /*
   * タブを立てる 2 段階（create → load）。
   * 1 段目で git を走らせてしまうと、UI 側はタブを先に見せられない。
   */
  it('create はルート解決だけで返る（一覧は取らない）', async () => {
    await write('a.txt', 'x');
    const session = await manager.create(dir);

    expect(session.gitDir).toContain('.git');
    expect(session.loaded).toBe(false);
    expect(manager.list()).toHaveLength(1);
    expect(manager.activeId).toBe(session.id);
    // ルート解決（対応表 #1）は track() を通らないのでコマンドログにも残らない
    expect(commandLog.size).toBe(0);
  });

  it('load で status / for-each-ref / remote が走り、二度目は走らない', async () => {
    const session = await manager.create(dir);

    await manager.load(session.id);
    expect(session.loaded).toBe(true);
    expect(commandLog.recent(20).map((e) => e.args[0]).sort()).toEqual([
      'for-each-ref',
      'remote',
      'status',
    ]);

    const before = commandLog.size;
    await manager.load(session.id);
    expect(commandLog.size).toBe(before);
  });

  it('load 中の実行はそのセッションの id で通知される（コマンドバーの絞り込みに使う）', async () => {
    const session = await manager.create(dir);
    await manager.load(session.id);

    expect(started.length).toBeGreaterThan(0);
    expect(started.every((e) => e.sessionId === session.id)).toBe(true);
    expect(ended).toHaveLength(started.length);
  });

  it('読み込み中に閉じられたタブの load は黙って終わる', async () => {
    const session = await manager.create(dir);
    manager.close(session.id);

    await expect(manager.load(session.id)).resolves.toBeUndefined();
    expect(commandLog.size).toBe(0);
  });

  it('同じリポジトリを二重に開かない', async () => {
    const a = await manager.open(dir);
    const b = await manager.open(dir);
    expect(b.id).toBe(a.id);
    expect(manager.list()).toHaveLength(1);
  });

  it('スナップショットの世代番号が更新ごとに進む', async () => {
    const session = await manager.open(dir);
    const seq0 = session.statusSeq;
    await write('b.txt', 'y');
    await manager.requestStatusRefresh(session.id);
    expect(session.statusSeq).toBeGreaterThan(seq0);
    expect(session.getStatusSummary().counts.untracked).toBe(1);
  });

  it('手動更新の連打で git が積み上がらない', async () => {
    const session = await manager.open(dir);
    const before = commandLog.size;

    await Promise.all([
      manager.requestStatusRefresh(session.id),
      manager.requestStatusRefresh(session.id),
      manager.requestStatusRefresh(session.id),
      manager.requestStatusRefresh(session.id),
    ]);

    expect(commandLog.size - before).toBeLessThanOrEqual(2);
  });

  it('タブ切替では git を 1 度も実行しない', async () => {
    const first = await manager.open(dir);

    const other = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(other, { recursive: true });
    await git(other, ['init', '--initial-branch=main']);
    try {
      const second = await manager.open(other);
      const before = commandLog.size;

      expect(await manager.activate(first.id)).toBe(true);
      expect(await manager.activate(second.id)).toBe(true);
      expect(await manager.activate(first.id)).toBe(true);

      expect(commandLog.size).toBe(before);
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    }
  });

  it('ページングで可視範囲だけを返す', async () => {
    for (let i = 0; i < 50; i += 1) await write(`f${String(i).padStart(3, '0')}.txt`, 'x');
    const session = await manager.open(dir);

    const page = session.getStatusPage(10, 5);
    expect(page.entries).toHaveLength(5);
    expect(page.filteredTotal).toBe(50);
    expect(page.offset).toBe(10);
  });

  it('未追跡ファイルの diff は git を呼ばずに作る', async () => {
    await write('new.txt', 'a');
    const session = await manager.open(dir);
    const before = commandLog.recent(50).filter((e) => e.args[0] === 'diff').length;

    const diff = await session.getDiff('new.txt', false);
    expect(diff?.hunks[0]?.lines).toHaveLength(1);

    const after = commandLog.recent(50).filter((e) => e.args[0] === 'diff').length;
    expect(after).toBe(before);
    expect(commandLog.recent(5)[0]?.args[0]).toBe('read-untracked');
  });

  it('タブを閉じると一覧から消える', async () => {
    const session = await manager.open(dir);
    manager.close(session.id);
    expect(manager.list()).toHaveLength(0);
    expect(manager.get(session.id)).toBeNull();
  });

  it('タブを並び替えられる', async () => {
    const first = await manager.open(dir);

    const other = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(other, { recursive: true });
    await git(other, ['init', '--initial-branch=main']);
    try {
      const second = await manager.open(other);
      manager.reorder([second.id, first.id]);
      expect(manager.list().map((s) => s.id)).toEqual([second.id, first.id]);
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    }
  });

  it('並び替えで不明な id は無視する', async () => {
    const session = await manager.open(dir);
    manager.reorder(['does-not-exist', session.id]);
    expect(manager.list().map((s) => s.id)).toEqual([session.id]);
  });

  it('並び替えで渡されなかった既存タブは末尾に元の順序で残る', async () => {
    const first = await manager.open(dir);

    const other = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(other, { recursive: true });
    await git(other, ['init', '--initial-branch=main']);
    try {
      const second = await manager.open(other);
      manager.reorder([]);
      expect(manager.list().map((s) => s.id)).toEqual([first.id, second.id]);
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    }
  });

  it('設定の変更が次の status に反映される', async () => {
    await write('sub/a.txt', 'x');
    const session = await manager.open(dir);
    expect(session.getStatusPage(0, 10).entries[0]?.path).toBe('sub/');

    settings = { ...DEFAULT_SETTINGS, untrackedFiles: 'all' };
    await manager.requestStatusRefresh(session.id);
    expect(session.getStatusPage(0, 10).entries[0]?.path).toBe('sub/a.txt');
  });

  /*
   * コマンドバーへの通知（決定 26）。
   * 発火点は track() の 1 箇所だけなので、ここが守れていれば全 git 実行が映る。
   */
  it('git の実行ごとに開始と終了を通知する', async () => {
    await write('a.txt', 'x');
    const session = await manager.open(dir);

    // 開くと status / for-each-ref / remote が走る（ルート解決は track を通らない）
    expect(started.map((e) => e.args[0])).toEqual(['status', 'for-each-ref', 'remote']);
    // 開始と終了は 1 対 1 で、全部終わっている
    expect(ended).toEqual(started.map((e) => e.opId));
    expect(started.every((e) => e.sessionId === session.id)).toBe(true);
    // opId は実行ごとに別のもの
    expect(new Set(started.map((e) => e.opId)).size).toBe(started.length);
  });

  it('実行が失敗しても終了は必ず通知する（コマンドバーに出しっぱなしにしない）', async () => {
    const session = await manager.open(dir);
    started.length = 0;
    ended.length = 0;

    await expect(session.track(['boom'], () => Promise.reject(new Error('失敗')))).rejects.toThrow('失敗');

    expect(started.map((e) => e.args)).toEqual([['boom']]);
    expect(ended).toEqual([started[0]?.opId]);
  });

  /*
   * 診断 §11 残存指摘: track() は fetch/pull/push など全ての git 実行が通る唯一の関門。
   * リモートに資格情報埋め込み URL（https://user:TOKEN@host/...）を設定していると、
   * git の stderr にそれがそのまま現れることがある。redactUrl を通さずに
   * commandLog へ渡ると平文でログに残ってしまう（クローン以外の経路での漏えい）。
   */
  it('fetch/push 相当の失敗で stderr に資格情報が残っていても、コマンドログでは伏せられる', async () => {
    const session = await manager.open(dir);

    const credentialedStderr =
      "fatal: unable to access 'https://user:TOKEN@host/repo.git/': The requested URL returned error: 403";
    await expect(
      session.track(['fetch', 'origin'], () => Promise.reject(new Error(credentialedStderr))),
    ).rejects.toThrow();

    const entry = commandLog.recent(20).find((e) => e.args[0] === 'fetch');
    expect(entry?.stderr).toBeDefined();
    expect(entry?.stderr).not.toContain('TOKEN');
    expect(entry?.stderr).toContain('https://***@host/repo.git/');
  });

  /*
   * SSH 鍵の設定（決定 13 の追記）。
   *
   * 文脈はコマンドごとに組み立て直されるので、設定を変えたら**次の git から効く**。
   * セッションを張り直したりアプリを再起動したりする必要は無い。
   */
  describe('SSH 鍵の注入', () => {
    it('鍵が未設定なら env を持たない（ユーザーの ssh 設定に任せる）', async () => {
      const session = await manager.create(dir);
      expect(session.context().env).toBeUndefined();
    });

    it('鍵を設定すると GIT_SSH_COMMAND が文脈に載り、変更が次の実行から効く', async () => {
      const session = await manager.create(dir);

      settings = { ...DEFAULT_SETTINGS, sshKeyPath: 'C:\\keys\\id_ed25519' };
      expect(session.context().env).toEqual({
        GIT_SSH_COMMAND: "ssh -i 'C:/keys/id_ed25519' -o IdentitiesOnly=yes",
      });

      settings = DEFAULT_SETTINGS;
      expect(session.context().env).toBeUndefined();
    });
  });
});

describe('補助関数', () => {
  it('表示名はパスの末尾要素', () => {
    expect(displayNameOf('D:/work/feather-tree')).toBe('feather-tree');
    expect(displayNameOf('D:/work/feather-tree/')).toBe('feather-tree');
  });

  it('git.exe を探索できる（この環境には git がある）', async () => {
    const found = await locateGit({ env: process.env });
    expect(found).not.toBeNull();
    expect(found?.source).toBe('path');
  });

  it('設定パスが存在すればそれを最優先する', async () => {
    const found = await locateGit({
      configuredPath: 'C:/custom/git.exe',
      env: process.env,
      exists: (p) => Promise.resolve(p === 'C:/custom/git.exe'),
    });
    expect(found).toEqual({ gitPath: 'C:/custom/git.exe', source: 'configured' });
  });

  it('どこにも無ければ null（導入案内は上位層の責務）', async () => {
    const found = await locateGit({
      env: { PATH: 'C:/nowhere' },
      exists: () => Promise.resolve(false),
      queryRegistry: () => Promise.resolve(null),
    });
    expect(found).toBeNull();
  });
});

describe('起動時のタブ復元', () => {
  let dirs: string[];
  let manager: SessionManager;
  let commandLog: CommandLog;

  beforeEach(async () => {
    dirs = [];
    for (let i = 0; i < 3; i += 1) {
      const dir = join(TEST_ROOT, randomBytes(8).toString('hex'));
      await mkdir(dir, { recursive: true });
      await git(dir, ['init', '--initial-branch=main']);
      await git(dir, ['config', 'user.name', 'T']);
      await git(dir, ['config', 'user.email', 't@example.invalid']);
      dirs.push(dir);
    }

    commandLog = new CommandLog();
    manager = new SessionManager({
      gitPath: GIT_PATH,
      tempDir: join(dirs[0] ?? '.', '.ft-tmp'),
      commandLog,
      settings: () => DEFAULT_SETTINGS,
    });
  });

  afterEach(async () => {
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
  });

  it('全タブを復元するが、一覧を取得するのはアクティブな 1 つだけ', async () => {
    const restored = await manager.restore(dirs);

    expect(restored).toHaveLength(3);
    expect(manager.list()).toHaveLength(3);

    // status / for-each-ref / remote が走るのは 1 リポジトリ分だけ
    const args = commandLog.recent(50).map((e) => e.args[0]);
    expect(args.filter((a) => a === 'status')).toHaveLength(1);
    expect(args.filter((a) => a === 'for-each-ref')).toHaveLength(1);

    const first = manager.get(restored[0] ?? '');
    expect(first?.loaded).toBe(true);
    expect(manager.get(restored[1] ?? '')?.loaded).toBe(false);
    expect(manager.get(restored[2] ?? '')?.loaded).toBe(false);
  });

  it('未読み込みタブに切り替えたときだけ、その 1 つを読み込む', async () => {
    const restored = await manager.restore(dirs);
    const second = restored[1] ?? '';
    const before = commandLog.size;

    await manager.activate(second);

    expect(manager.get(second)?.loaded).toBe(true);
    expect(commandLog.size - before).toBe(3);

    // 2 回目の切替では git を 1 度も実行しない
    const after = commandLog.size;
    await manager.activate(second);
    expect(commandLog.size).toBe(after);
  });

  it('開けないリポジトリは黙って飛ばす', async () => {
    const missing = join(TEST_ROOT, 'does-not-exist-xyz');
    const restored = await manager.restore([missing, ...dirs]);
    expect(restored).toHaveLength(3);
  });

  it('既に開いているリポジトリは二重に復元しない', async () => {
    await manager.restore(dirs);
    const again = await manager.restore(dirs);
    expect(again).toHaveLength(0);
    expect(manager.list()).toHaveLength(3);
  });
});
