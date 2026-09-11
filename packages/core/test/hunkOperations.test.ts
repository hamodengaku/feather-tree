import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandLog,
  DEFAULT_SETTINGS,
  SessionManager,
  SessionOperations,
  StaleDiffError,
} from '../src/index.js';

const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/core-hunk-tests');
const GIT_PATH = process.env['FT_TEST_GIT'] ?? 'git';
const LF = String.fromCharCode(10);
const SP = String.fromCharCode(32);

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(GIT_PATH, [...args], { cwd, shell: false, windowsHide: true, stdio: 'ignore' });
    child.on('error', rej);
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`git failed: ${String(code)}`))));
  });
}

describe('SessionOperations の hunk / 行操作 (対応表 #33 / #34)', () => {
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
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });

  async function write(rel: string, content: string): Promise<void> {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  /** 3 hunk に割れる変更を作り、セッションを開いて返す。 */
  async function openWithThreeHunks(): Promise<{
    session: Awaited<ReturnType<SessionManager['open']>>;
    ops: SessionOperations;
  }> {
    const base = Array.from({ length: 30 }, (_, i) => `line${String(i + 1)}`);
    await write('a.txt', base.join(LF) + LF);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);

    const edited = [...base];
    edited[1] = 'CHANGED-A';
    edited[14] = 'CHANGED-B';
    edited[27] = 'CHANGED-C';
    await write('a.txt', edited.join(LF) + LF);

    const session = await manager.open(dir);
    return { session, ops: new SessionOperations(session) };
  }

  it('hunk を 1 つステージすると status が進み、残りは未ステージのまま', async () => {
    const { session, ops } = await openWithThreeHunks();
    const diff = await session.getDiff('a.txt', false);
    const hunk = diff?.hunks[1];
    expect(hunk).toBeDefined();

    const outcome = await ops.stageHunks('a.txt', [
      { index: 1, header: hunk!.header, lineCount: hunk!.lines.length, lines: null },
    ]);

    expect(outcome.affected).toBe(2);
    expect(outcome.statusSeq).toBe(session.statusSeq);

    const staged = await session.getDiff('a.txt', true);
    expect(staged?.hunks).toHaveLength(1);
    const rest = await session.getDiff('a.txt', false);
    expect(rest?.hunks).toHaveLength(2);
  });

  it('実行ログに diff → apply → status の順で残る（3 プロセスの内訳が見える）', async () => {
    const { session, ops } = await openWithThreeHunks();
    const diff = await session.getDiff('a.txt', false);
    const hunk = diff!.hunks[0]!;
    const before = commandLog.size;

    await ops.stageHunks('a.txt', [
      { index: 0, header: hunk.header, lineCount: hunk.lines.length, lines: null },
    ]);

    const added = commandLog.recent(10).slice(0, commandLog.size - before);
    const labels = added.map((e) => e.args.join(SP)).reverse();
    expect(labels[0]).toBe('diff' + SP + 'a.txt');
    expect(labels[1]).toBe('apply' + SP + '--cached');
    expect(labels[2]).toBe('status');
  });

  it('ヘッダが変わっていたら適用せずに StaleDiffError', async () => {
    const { session, ops } = await openWithThreeHunks();
    const diff = await session.getDiff('a.txt', false);
    const hunk = diff!.hunks[0]!;

    await expect(
      ops.stageHunks('a.txt', [
        { index: 0, header: '@@ -999,3 +999,3 @@', lineCount: hunk.lines.length, lines: null },
      ]),
    ).rejects.toBeInstanceOf(StaleDiffError);

    const staged = await session.getDiff('a.txt', true);
    expect(staged?.hunks ?? []).toHaveLength(0);
  });

  it('行数が変わっていたら StaleDiffError', async () => {
    const { session, ops } = await openWithThreeHunks();
    const diff = await session.getDiff('a.txt', false);
    const hunk = diff!.hunks[0]!;

    await expect(
      ops.stageHunks('a.txt', [{ index: 0, header: hunk.header, lineCount: 999, lines: null }]),
    ).rejects.toBeInstanceOf(StaleDiffError);
  });

  it('存在しない hunk を指しても StaleDiffError（適用前に弾く）', async () => {
    const { session, ops } = await openWithThreeHunks();
    const diff = await session.getDiff('a.txt', false);
    const hunk = diff!.hunks[0]!;

    await expect(
      ops.stageHunks('a.txt', [
        { index: 99, header: hunk.header, lineCount: hunk.lines.length, lines: null },
      ]),
    ).rejects.toBeInstanceOf(StaleDiffError);
  });

  it('外部でファイルが書き換わっていたら StaleDiffError', async () => {
    const { session, ops } = await openWithThreeHunks();
    const diff = await session.getDiff('a.txt', false);
    const hunk = diff!.hunks[0]!;

    // 表示したあとにファイルが変わる（決定 14 によりアプリは気付けない）
    await write('a.txt', ['まったく', '別の', '内容'].join(LF) + LF);

    await expect(
      ops.stageHunks('a.txt', [
        { index: 0, header: hunk.header, lineCount: hunk.lines.length, lines: null },
      ]),
    ).rejects.toBeInstanceOf(StaleDiffError);
  });

  it('未追跡ファイルは hunk 単位で扱えない', async () => {
    await write('base.txt', 'x' + LF);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('new.txt', ['a', 'b'].join(LF) + LF);

    const session = await manager.open(dir);
    const ops = new SessionOperations(session);
    const diff = await session.getDiff('new.txt', false);
    const hunk = diff!.hunks[0]!;

    await expect(
      ops.stageHunks('new.txt', [
        { index: 0, header: hunk.header, lineCount: hunk.lines.length, lines: null },
      ]),
    ).rejects.toMatchObject({ name: 'PatchBuildError' });
  });

  it('ステージ済みの hunk を 1 つだけ戻せる', async () => {
    const { session, ops } = await openWithThreeHunks();
    await git(dir, ['add', 'a.txt']);
    await session.refreshStatus();

    const staged = await session.getDiff('a.txt', true);
    expect(staged?.hunks).toHaveLength(3);
    const hunk = staged!.hunks[1]!;

    await ops.unstageHunks('a.txt', [
      { index: 1, header: hunk.header, lineCount: hunk.lines.length, lines: null },
    ]);

    const after = await session.getDiff('a.txt', true);
    expect(after?.hunks).toHaveLength(2);
  });

  it('選択が空なら git を実行しない', async () => {
    const { ops } = await openWithThreeHunks();
    const before = commandLog.size;

    await expect(ops.stageHunks('a.txt', [])).rejects.toMatchObject({ name: 'PatchBuildError' });
    expect(commandLog.size).toBe(before);
  });
});
