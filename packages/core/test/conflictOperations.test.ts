import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandLog,
  ConflictUnsupportedError,
  DEFAULT_SETTINGS,
  SessionManager,
  SessionOperations,
  StaleDiffError,
  type ConflictSelection,
  type RepositorySession,
} from '../src/index.js';

const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/core-conflict-tests');
const GIT_PATH = process.env['FT_TEST_GIT'] ?? 'git';
const LF = String.fromCharCode(10);

function git(cwd: string, args: readonly string[], allowFailure = false): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(GIT_PATH, [...args], { cwd, shell: false, windowsHide: true, stdio: 'ignore' });
    child.on('error', rej);
    child.on('close', (code) =>
      code === 0 || allowFailure ? res() : rej(new Error(`git failed: ${String(code)}`)),
    );
  });
}

/**
 * コンフリクトの採用（対応表の対象外 — **git を 1 プロセスも起動しない**）。
 *
 * ここで見るのは 3 点。
 *   1. 作業ツリーのファイルだけが変わり、インデックスは未マージのまま
 *   2. 表示していたものと形が違えば書かずに断る（hunk 適用と同じ指紋の照合）
 *   3. git が走らない（`status` の取り直しもしない）
 */
describe('SessionOperations.resolveConflict', () => {
  let dir: string;
  let manager: SessionManager;
  let commandLog: CommandLog;

  beforeEach(async () => {
    dir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(dir, { recursive: true });
    await git(dir, ['init', '--initial-branch=main']);
    await git(dir, ['config', 'user.name', 'T']);
    await git(dir, ['config', 'user.email', 't@example.invalid']);
    await git(dir, ['config', 'core.autocrlf', 'false']);

    commandLog = new CommandLog();
    manager = new SessionManager({
      gitPath: GIT_PATH,
      tempDir: join(dir, '.ft-tmp'),
      commandLog,
      settings: () => DEFAULT_SETTINGS,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      () => undefined,
    );
  });

  const write = (rel: string, content: string): Promise<void> =>
    writeFile(join(dir, rel), content, 'utf8');

  const read = (rel: string): Promise<string> => readFile(join(dir, rel), 'utf8');

  /** 1 箇所だけ衝突するリポジトリを作る。 */
  async function makeConflict(): Promise<RepositorySession> {
    await write('f.txt', ['a', 'b', 'c'].join(LF) + LF);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'base']);
    await git(dir, ['switch', '-c', 'feature']);
    await write('f.txt', ['a', 'THEIRS', 'c'].join(LF) + LF);
    await git(dir, ['commit', '-am', 'theirs']);
    await git(dir, ['switch', 'main']);
    await write('f.txt', ['a', 'OURS', 'c'].join(LF) + LF);
    await git(dir, ['commit', '-am', 'ours']);
    // 衝突するので exit != 0。ここでは失敗が期待値
    await git(dir, ['merge', 'feature'], true);
    return manager.open(dir);
  }

  /** 表示側が送ってくる指定を、今のファイルの状態から組み立てる。 */
  async function selectionOf(session: RepositorySession, index = 0): Promise<ConflictSelection> {
    const file = await session.getConflict('f.txt');
    const section = file?.sections[index];
    if (section === undefined) throw new Error('衝突が見つからない');
    return {
      index: section.index,
      startLine: section.startLine,
      endLine: section.endLine,
      ourCount: section.ourCount,
      theirCount: section.theirCount,
    };
  }

  it('採用しても git は 1 プロセスも走らず、作業ツリーだけが変わる', async () => {
    const session = await makeConflict();
    const ops = new SessionOperations(session);
    const selection = await selectionOf(session);
    const before = commandLog.size;

    const outcome = await ops.resolveConflict('f.txt', selection, 'ours');

    expect(outcome.remaining).toBe(0);
    expect(await read('f.txt')).toBe(['a', 'OURS', 'c'].join(LF) + LF);

    // 記録されるのはファイルの読み書きだけ（git のサブコマンドは 1 つも無い）
    const added = commandLog.recent(20).slice(0, commandLog.size - before);
    expect(added.map((e) => e.args[0]).sort()).toEqual(['read-conflict', 'write-conflict']);
  });

  it('インデックスは未マージのまま（解決済みにするのは利用者のステージ）', async () => {
    const session = await makeConflict();
    const ops = new SessionOperations(session);

    await ops.resolveConflict('f.txt', await selectionOf(session), 'theirs');

    // status は取り直していないので、保持しているスナップショットも未マージのまま
    expect(session.getStatusSummary().counts.unmerged).toBe(1);

    // 取り直しても未マージ（書いたのは作業ツリーだけ）
    await session.refreshStatus();
    expect(session.getStatusSummary().counts.unmerged).toBe(1);

    // ステージして初めて解決済みになる
    await ops.stage({ kind: 'paths', paths: ['f.txt'] });
    expect(session.getStatusSummary().counts.unmerged).toBe(0);
    expect(session.getStatusSummary().counts.staged).toBe(1);
  });

  it('両方を残す 2 つは順序だけが違う', async () => {
    const session = await makeConflict();
    const ops = new SessionOperations(session);

    await ops.resolveConflict('f.txt', await selectionOf(session), 'theirs-ours');
    expect(await read('f.txt')).toBe(['a', 'THEIRS', 'OURS', 'c'].join(LF) + LF);
  });

  it('表示していたものと形が違えば、何も書かずに断る', async () => {
    const session = await makeConflict();
    const ops = new SessionOperations(session);
    const selection = await selectionOf(session);
    const stale: ConflictSelection = { ...selection, ourCount: selection.ourCount + 1 };
    const before = await read('f.txt');

    await expect(ops.resolveConflict('f.txt', stale, 'ours')).rejects.toBeInstanceOf(StaleDiffError);
    expect(await read('f.txt')).toBe(before);
  });

  it('マーカーの対応が取れないファイルは書き換えない', async () => {
    const session = await makeConflict();
    const ops = new SessionOperations(session);
    const selection = await selectionOf(session);

    // 表示した後に誰かが壊した状態（閉じていないマーカー）
    const broken = ['<<<<<<< HEAD', 'x'].join(LF) + LF;
    await write('f.txt', broken);

    await expect(ops.resolveConflict('f.txt', selection, 'ours')).rejects.toBeInstanceOf(
      ConflictUnsupportedError,
    );
    expect(await read('f.txt')).toBe(broken);
  });

  it('ファイルが消えていれば古くなったものとして断る', async () => {
    const session = await makeConflict();
    const ops = new SessionOperations(session);
    const selection = await selectionOf(session);
    await rm(join(dir, 'f.txt'));

    await expect(ops.resolveConflict('f.txt', selection, 'ours')).rejects.toBeInstanceOf(
      StaleDiffError,
    );
  });
});
