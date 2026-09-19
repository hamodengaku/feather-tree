import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitNotFoundError,
  GitTimeoutError,
  killAllGitProcesses,
  runGitText,
  runningGitCount,
} from '../src/index.js';
import { createFixture, GIT_PATH, type Fixture } from './fixture.js';

/**
 * 子プロセスの終了検知・タイムアウト・レジストリの検証。
 *
 * ここでの「git」は node.exe で代用する。目的は git の機能ではなく
 * spawnGit の run() の待ち方そのものなので、挙動を厳密に作れる node のほうが適切
 * （git には「本体は終了するが孫がパイプを掴んだまま残る」状態を狙って作る手段が無い）。
 */

/** 孫プロセスが生き続ける時間。回帰時にテストを待たせすぎない範囲で十分長く取る。 */
const GRANDCHILD_LIFE_MS = 20_000;

/**
 * 自分は即座に終了するが、stdout / stderr を継承した孫を残す子。
 *
 * この状態では 'close'（全 stdio が閉じた）は孫が死ぬまで発火しない。
 * 'exit' を見ていなければ run() は永久に await する。
 * 孫の pid を stdout に書いてからexit するので、テスト側で後始末できる。
 */
const LEAVE_GRANDCHILD = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  `const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${GRANDCHILD_LIFE_MS})'], {`,
  "  stdio: ['ignore', 'inherit', 'inherit'],",
  '});',
  // process.exit の直後だと非同期書き込みが失われるので同期で書く
  "fs.writeSync(1, String(g.pid) + '\\n');",
  'process.exit(7);',
].join('\n');

/** ただ待つだけの子。タイムアウトと強制終了の検証用。 */
const SLEEP_FOREVER = `setTimeout(() => {}, ${GRANDCHILD_LIFE_MS})`;

/**
 * 回帰したときに testTimeout（30 秒）まで待たされないよう、明示的な締切を付ける。
 * 「永久に返らない」バグの検出器なので、失敗は速いほど良い。
 */
async function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_res, rej) => {
        timer = setTimeout(() => rej(new Error(`${message}（${String(ms)}ms 超過）`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitUntil(predicate: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('条件が満たされないまま待機時間を超えた');
    await new Promise((res) => setTimeout(res, 20));
  }
}

function killQuietly(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid);
  } catch {
    // 既に終了していれば何もしない
  }
}

describe('子プロセスの終了検知と後始末', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('close が来なくても exit で解決する（孫がパイプを掴んだまま残るケース）', async () => {
    const startedAt = Date.now();
    const { exit, stdout } = await withDeadline(
      runGitText({ gitPath: process.execPath, cwd: fx.dir, args: ['-e', LEAVE_GRANDCHILD] }),
      8_000,
      'exit を見ずに close を待ち続けている',
    );

    killQuietly(Number.parseInt(stdout.trim(), 10));

    expect(exit.code).toBe(7);
    // stderr 読み切りの猶予だけを足した時間で返ること（孫の寿命を待っていない）
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('timeoutMs を超えたら GitTimeoutError になり、プロセスが残らない', async () => {
    const startedAt = Date.now();
    const promise = runGitText({
      gitPath: process.execPath,
      cwd: fx.dir,
      args: ['-e', SLEEP_FOREVER],
      timeoutMs: 300,
    });

    await expect(withDeadline(promise, 8_000, 'タイムアウトが発火していない')).rejects.toBeInstanceOf(
      GitTimeoutError,
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(runningGitCount()).toBe(0);
  });

  it('正常終了でもレジストリから外れる', async () => {
    const before = runningGitCount();
    await runGitText({ gitPath: GIT_PATH, cwd: fx.dir, args: ['--version'] });
    expect(runningGitCount()).toBe(before);
  });

  it('実行中の子が runningGitCount に載り、killAllGitProcesses で全件落ちる', async () => {
    const before = runningGitCount();

    const a = runGitText({ gitPath: process.execPath, cwd: fx.dir, args: ['-e', SLEEP_FOREVER] });
    const b = runGitText({ gitPath: process.execPath, cwd: fx.dir, args: ['-e', SLEEP_FOREVER] });

    await waitUntil(() => runningGitCount() >= before + 2, 5_000);

    await killAllGitProcesses();

    await withDeadline(Promise.allSettled([a, b]), 8_000, '強制終了後も実行が返ってこない');
    expect(runningGitCount()).toBe(before);
  });

  it('cwd が存在しないときは「git が見つかりません」にしない', async () => {
    const missing = resolve(fx.dir, 'no-such-directory-xyz');
    await expect(access(missing)).rejects.toBeInstanceOf(Error);

    const err: unknown = await runGitText({
      gitPath: GIT_PATH,
      cwd: missing,
      args: ['--version'],
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GitNotFoundError);
    expect((err as Error).name).toBe('GitWorkingDirectoryError');
    expect((err as Error).message).toContain(missing);
    // git 本体の導入を促す文言になっていないこと（これが誤判定の実害）
    expect((err as Error).message).not.toContain('git を実行できませんでした');
  });
});
