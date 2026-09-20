import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandLog,
  DEFAULT_SETTINGS,
  MAX_EXPLICIT_PATHS,
  NoSnapshotError,
  SessionManager,
  SessionOperations,
  TooManyPathsError,
} from '../src/index.js';

const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/core-op-tests');
const GIT_PATH = process.env['FT_TEST_GIT'] ?? 'git';

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(GIT_PATH, [...args], { cwd, shell: false, windowsHide: true, stdio: 'ignore' });
    child.on('error', rej);
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`git failed: ${String(code)}`))));
  });
}

/** 検証用に git の出力を読む（アプリの層を通さず、実リポジトリの状態を直接確かめる）。 */
function gitOut(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(GIT_PATH, [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.on('error', rej);
    child.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`git failed: ${String(code)}`))));
  });
}

describe('SessionOperations (対応表 #5〜#11 の統合)', () => {
  let dir: string;
  let manager: SessionManager;
  let commandLog: CommandLog;

  beforeEach(async () => {
    dir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(dir, { recursive: true });
    await git(dir, ['init', '--initial-branch=main']);
    await git(dir, ['config', 'user.name', 'T']);
    await git(dir, ['config', 'user.email', 't@example.invalid']);

    commandLog = new CommandLog();
    manager = new SessionManager({
      gitPath: GIT_PATH,
      tempDir: join(dir, '.ft-tmp'),
      commandLog,
      settings: () => DEFAULT_SETTINGS,
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

  function lines(text: string): string[] {
    return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  }

  /** index と HEAD の差があるパス（`git diff --cached --name-only`）。 */
  async function diffCachedNames(): Promise<string[]> {
    return lines(await gitOut(dir, ['diff', '--cached', '--name-only']));
  }

  /** 作業ツリーと index の差があるパス（`git diff --name-only`）。 */
  async function diffNames(): Promise<string[]> {
    return lines(await gitOut(dir, ['diff', '--name-only']));
  }

  /** index に載っている内容（`git show :<path>`）。 */
  async function showIndex(rel: string): Promise<string> {
    return await gitOut(dir, ['show', ':' + rel]);
  }

  it('kind all でパス配列を IPC に流さずに全件ステージできる', async () => {
    for (let i = 0; i < 30; i += 1) await write(`f${String(i)}.txt`, 'x');
    const session = await manager.open(dir);
    const ops = new SessionOperations(session);

    const outcome = await ops.stage({ kind: 'all' });

    expect(outcome.affected).toBe(30);
    expect(session.getStatusSummary().counts.staged).toBe(30);
  });

  it('kind filtered でグループを指定してステージできる', async () => {
    await write('a.txt', 'one');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('a.txt', 'two');
    await write('new.txt', 'y');

    const session = await manager.open(dir);
    const ops = new SessionOperations(session);

    await ops.stage({ kind: 'filtered', filter: { group: 'untracked' } });

    expect(session.getStatusSummary().counts.staged).toBe(1);
    const page = session.getStatusPage(0, 10, { group: 'unstaged' });
    expect(page.entries.map((e) => e.path)).toEqual(['a.txt']);
  });

  it('1 操作あたり git は「操作 1 回 + status 1 回」だけ', async () => {
    await write('a.txt', 'x');
    const session = await manager.open(dir);
    const ops = new SessionOperations(session);
    const before = commandLog.size;

    await ops.stage({ kind: 'all' });

    const added = commandLog.recent(10).slice(0, commandLog.size - before);
    expect(added.map((e) => e.args[0]).sort()).toEqual(['add', 'status']);
  });

  it('破棄は常に #7 だけを打つ（ステージ済みの有無で切り替えない）', async () => {
    await write('a.txt', 'one');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('a.txt', 'staged');
    await git(dir, ['add', 'a.txt']);
    await write('a.txt', 'worktree');

    const session = await manager.open(dir);
    const ops = new SessionOperations(session);
    const before = commandLog.size;

    await ops.discard({ kind: 'paths', paths: ['a.txt'] });

    // 打つのは restore（#7）と status の 2 本だけ
    const added = commandLog.recent(10).slice(0, commandLog.size - before);
    expect(added.map((e) => e.args[0]).sort()).toEqual(['restore', 'status']);
    expect(added.find((e) => e.args[0] === 'restore')?.args).not.toContain('--staged');

    // 作業ツリーは**インデックスの内容**（= ステージした 'staged'）に戻る。HEAD の 'one' ではない
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('staged');
    // ステージ済みの差分が残るので、status の件数も 0 にはならない
    expect(session.getStatusSummary().counts.staged).toBe(1);
  });

  it('ステージ済みがあるファイルの変更を破棄しても、インデックスの内容は温存される', async () => {
    await write('a.txt', 'one');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('a.txt', 'staged');
    await git(dir, ['add', 'a.txt']);
    await write('a.txt', 'worktree');

    const session = await manager.open(dir);
    const ops = new SessionOperations(session);

    await ops.discard({ kind: 'paths', paths: ['a.txt'] });

    // 実 git に訊く: index と HEAD の差（git diff --cached 相当）が残っていること
    expect(await diffCachedNames()).toEqual(['a.txt']);
    expect(await showIndex('a.txt')).toBe('staged');
    // 作業ツリー側の差（未ステージ分）は消えていること
    expect(await diffNames()).toEqual([]);
  });

  it('未追跡削除は未追跡エントリだけに絞る（追跡ファイルを誤って消さない）', async () => {
    await write('tracked.txt', 'keep');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('tracked.txt', 'modified');
    await write('untracked.txt', 'trash');

    const session = await manager.open(dir);
    const ops = new SessionOperations(session);

    // 追跡ファイルも一緒に指定しても、消えるのは未追跡だけ
    const outcome = await ops.deleteUntracked({ kind: 'paths', paths: ['tracked.txt', 'untracked.txt'] });

    expect(outcome.affected).toBe(1);
    await expect(stat(join(dir, 'untracked.txt'))).rejects.toThrow();
    expect(await readFile(join(dir, 'tracked.txt'), 'utf8')).toBe('modified');
  });

  it('コミット後に status が更新され世代番号が進む', async () => {
    await write('a.txt', 'x');
    const session = await manager.open(dir);
    const ops = new SessionOperations(session);
    await ops.stage({ kind: 'all' });
    const seqBefore = session.statusSeq;

    const result = await ops.commit('日本語のコミット');

    expect(result.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(result.statusSeq).toBeGreaterThan(seqBefore);
    expect(session.getStatusSummary().counts.total).toBe(0);
  });

  it('ブランチ切替後は status のみ再取得する（対応表 #12 → #2）', async () => {
    await write('a.txt', 'x');
    const session = await manager.open(dir);
    const ops = new SessionOperations(session);
    await ops.stage({ kind: 'all' });
    await ops.commit('init');
    await git(dir, ['branch', 'feature']);
    const before = commandLog.size;

    const result = await ops.switchBranch('feature');

    expect(session.snapshot?.head.branch).toBe('feature');
    expect(result.statusSeq).toBe(session.statusSeq);
    expect(result.branchesRefreshed).toBe(false);
    const added = commandLog.recent(10).slice(0, commandLog.size - before);
    expect(added.map((e) => e.args[0]).sort()).toEqual(['status', 'switch']);
  });

  it('リモートブランチの取り出しはブランチ一覧も取り直す（対応表 #47 → #2 → #3）', async () => {
    // 疑似リモート（もう 1 つの使い捨てリポジトリ）に feature/x を用意する
    const remoteDir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(remoteDir, { recursive: true });
    await git(remoteDir, ['init', '--initial-branch=main']);
    await git(remoteDir, ['config', 'user.name', 'T']);
    await git(remoteDir, ['config', 'user.email', 't@example.invalid']);
    await writeFile(join(remoteDir, 'u.txt'), 'x', 'utf8');
    await git(remoteDir, ['add', '-A']);
    await git(remoteDir, ['commit', '-m', 'upstream init']);
    await git(remoteDir, ['switch', '-c', 'feature/x']);
    await writeFile(join(remoteDir, 'f.txt'), 'from feature', 'utf8');
    await git(remoteDir, ['add', '-A']);
    await git(remoteDir, ['commit', '-m', 'feature work']);
    await git(remoteDir, ['switch', 'main']);

    try {
      await write('a.txt', 'x');
      const session = await manager.open(dir);
      const ops = new SessionOperations(session);
      await ops.stage({ kind: 'all' });
      await ops.commit('init');
      await git(dir, ['remote', 'add', 'origin', remoteDir]);
      await git(dir, ['fetch', 'origin']);
      const before = commandLog.size;

      const result = await ops.switchToRemoteBranch('origin/feature/x');

      expect(session.snapshot?.head.branch).toBe('feature/x');
      expect(result.branchesRefreshed).toBe(true);
      // 一覧を取り直しているので、更新ボタンを押さなくても新しいローカル枝が見える
      const local = session.branches.find((b) => !b.isRemote && b.shortName === 'feature/x');
      expect(local?.upstream).toBe('origin/feature/x');
      const added = commandLog.recent(10).slice(0, commandLog.size - before);
      expect(added.map((e) => e.args.join(' ')).sort()).toEqual([
        'for-each-ref',
        'status',
        'switch --track',
      ]);
    } finally {
      await rm(remoteDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    }
  });

  it('ブランチ作成は起点から分岐して切替まで行い、一覧も取り直す（対応表 #14 → #2 → #3）', async () => {
    await write('a.txt', 'x');
    const session = await manager.open(dir);
    const ops = new SessionOperations(session);
    await ops.stage({ kind: 'all' });
    await ops.commit('init');
    const before = commandLog.size;

    const result = await ops.createBranch('feature', 'main');

    expect(session.snapshot?.head.branch).toBe('feature');
    expect(result.statusSeq).toBe(session.statusSeq);
    // 作ったブランチは #3 の結果にしか現れない。取り直さないと一覧に出ないまま印だけが消える
    expect(session.branches.some((b) => !b.isRemote && b.shortName === 'feature')).toBe(true);
    const added = commandLog.recent(10).slice(0, commandLog.size - before);
    expect(added.map((e) => e.args[0]).sort()).toEqual(['for-each-ref', 'status', 'switch']);
  });

  it('マージが競合で失敗したら、例外を投げる前に status を取り直す（対応表 #35 → #2）', async () => {
    await write('a.txt', 'base');
    const session = await manager.open(dir);
    const ops = new SessionOperations(session);
    await ops.stage({ kind: 'all' });
    await ops.commit('init');
    await ops.createBranch('topic', 'main');
    await write('a.txt', 'topic side');
    // 書いた直後はスナップショットに載っていない（決定 14: 監視もポーリングもしない）
    await session.refreshStatus();
    await ops.stage({ kind: 'all' });
    await ops.commit('topic edit');
    await ops.switchBranch('main');
    await write('a.txt', 'main side');
    await session.refreshStatus();
    await ops.stage({ kind: 'all' });
    await ops.commit('main edit');
    const before = commandLog.size;

    await expect(ops.mergeBranch('topic')).rejects.toThrow();

    // 競合したファイルが、更新ボタンを押さなくても一覧に出ている
    expect(session.getStatusSummary().counts.unmerged).toBe(1);
    expect(session.getStatusPage(0, 50, { group: 'changes' }).entries.map((e) => e.path)).toEqual(['a.txt']);
    // 失敗の後始末は #2 だけ（枝の先端は動いていないので #3 は打たない）
    const added = commandLog.recent(10).slice(0, commandLog.size - before);
    expect(added.map((e) => e.args[0]).sort()).toEqual(['merge', 'status']);
  });

  it('明示パスの上限を超えたら拒否する', async () => {
    await write('a.txt', 'x');
    const session = await manager.open(dir);
    const ops = new SessionOperations(session);

    const tooMany = Array.from({ length: MAX_EXPLICIT_PATHS + 1 }, (_, i) => `f${String(i)}.txt`);
    await expect(ops.stage({ kind: 'paths', paths: tooMany })).rejects.toBeInstanceOf(TooManyPathsError);
  });

  it('スナップショット未取得なら操作を拒否する', async () => {
    const session = await manager.open(dir);
    const fake = Object.create(Object.getPrototypeOf(session) as object) as typeof session;
    Object.defineProperty(fake, 'snapshot', { get: () => null });
    const ops = new SessionOperations(fake);
    await expect(ops.stage({ kind: 'all' })).rejects.toBeInstanceOf(NoSnapshotError);
  });

  it('確認が必要な操作を正しく判定する', () => {
    expect(SessionOperations.confirmationFor('stage')).toBeNull();
    expect(SessionOperations.confirmationFor('unstage')).toBeNull();
    expect(SessionOperations.confirmationFor('commit')).toBeNull();
    expect(SessionOperations.confirmationFor('commit', { amend: true })).toBe('amend-pushed-commit');
    // 破棄の確認は 1 種類だけ（#8 の廃止に伴い、ステージ済みの有無で変えない）
    expect(SessionOperations.confirmationFor('discard')).toBe('discard-changes');
    expect(SessionOperations.confirmationFor('discard', { hasStaged: true })).toBe('discard-changes');
    expect(SessionOperations.confirmationFor('deleteUntracked')).toBe('delete-untracked');
  });

  it('対象が空なら git を実行しない', async () => {
    await write('a.txt', 'x');
    const session = await manager.open(dir);
    const ops = new SessionOperations(session);
    const before = commandLog.size;

    const outcome = await ops.discard({ kind: 'filtered', filter: { group: 'staged' } });

    expect(outcome.affected).toBe(0);
    expect(commandLog.size).toBe(before);
  });
});
