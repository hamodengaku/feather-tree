import { describe, expect, it, vi } from 'vitest';
import type * as SpawnGitModule from '../src/execution/spawnGit.js';
import type { GitCommand } from '../src/execution/spawnGit.js';
import type { GitContext } from '../src/commands/context.js';

/**
 * 「読み取り系にはタイムアウトが載り、書き込み系・通信系には載らない」ことの検証
 * （docs/02-git-command-map.md キャンセル・タイムアウト節）。
 *
 * 実際に git を起動すると値が観測できないので、spawnGit を差し替えて
 * 各コマンドが組み立てた GitCommand をそのまま捕まえる。
 * 定数そのものは actual から取り直すので、値の変更はここで検出できる。
 */
const { calls } = vi.hoisted(() => ({ calls: [] as GitCommand[] }));

vi.mock('../src/execution/spawnGit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SpawnGitModule>();
  const exit = { code: 0, elapsedMs: 0, stderr: '' };
  return {
    ...actual,
    runGitText: vi.fn((cmd: GitCommand) => {
      calls.push(cmd);
      return Promise.resolve({ exit, stdout: '' });
    }),
    runGitStream: vi.fn((cmd: GitCommand, sink: { finish: () => unknown }) => {
      calls.push(cmd);
      return Promise.resolve({ exit, result: sink.finish() });
    }),
    runGitWithProgress: vi.fn((cmd: GitCommand) => {
      calls.push(cmd);
      return Promise.resolve(exit);
    }),
  };
});

const {
  DIFF_TIMEOUT_MS,
  REF_LIST_TIMEOUT_MS,
  REV_PARSE_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
} = await import('../src/execution/spawnGit.js');

const { getGitVersion, listRemotes, resolveRepository } = await import('../src/commands/repository.js');
const { getStatus } = await import('../src/commands/status.js');
const { createBranch, listBranches, mergeBranch, switchBranch } = await import(
  '../src/commands/branches.js'
);
const { getFileDiff } = await import('../src/commands/diff.js');
const { getCommitFileDiff, getCommitFiles, getLog } = await import('../src/commands/history.js');
const { fetchRemote } = await import('../src/commands/remote.js');

const ctx: GitContext = {
  gitPath: 'git',
  cwd: 'C:/not/used/because/spawn/is/mocked',
  tempDir: 'C:/not/used/because/spawn/is/mocked/.tmp',
};

/**
 * 1 コマンド実行して、組み立てられた GitCommand を取り出す。
 * 出力が空なのでパース段階で失敗する関数があるが、ここで見たいのは spawn 引数だけ。
 */
async function capture(run: () => Promise<unknown>): Promise<GitCommand> {
  calls.length = 0;
  await run().catch(() => undefined);
  const cmd = calls[0];
  if (cmd === undefined) throw new Error('git が 1 回も呼ばれなかった');
  return cmd;
}

describe('読み取り系コマンドのタイムアウト配線', () => {
  it('対応表の目安と定数が一致する', () => {
    expect(REV_PARSE_TIMEOUT_MS).toBe(10_000);
    expect(STATUS_TIMEOUT_MS).toBe(300_000);
    expect(REF_LIST_TIMEOUT_MS).toBe(60_000);
    expect(DIFF_TIMEOUT_MS).toBe(120_000);
  });

  it('#1 rev-parse は 10 秒', async () => {
    const cmd = await capture(() => resolveRepository(ctx));
    expect(cmd.args).toContain('rev-parse');
    expect(cmd.timeoutMs).toBe(REV_PARSE_TIMEOUT_MS);
  });

  it('#2 status は 300 秒', async () => {
    const cmd = await capture(() => getStatus(ctx));
    expect(cmd.args).toContain('status');
    expect(cmd.timeoutMs).toBe(STATUS_TIMEOUT_MS);
  });

  it('#3 for-each-ref / #4 remote は 60 秒', async () => {
    const refs = await capture(() => listBranches(ctx));
    expect(refs.args).toContain('for-each-ref');
    expect(refs.timeoutMs).toBe(REF_LIST_TIMEOUT_MS);

    const remotes = await capture(() => listRemotes(ctx));
    expect(remotes.args).toContain('remote');
    expect(remotes.timeoutMs).toBe(REF_LIST_TIMEOUT_MS);
  });

  it('#18 / #19 diff、#20 log、#21 show、#36 は 120 秒', async () => {
    const diff = await capture(() => getFileDiff(ctx, 'a.txt', false));
    expect(diff.args).toContain('diff');
    expect(diff.timeoutMs).toBe(DIFF_TIMEOUT_MS);

    const staged = await capture(() => getFileDiff(ctx, 'a.txt', true));
    expect(staged.timeoutMs).toBe(DIFF_TIMEOUT_MS);

    const log = await capture(() => getLog(ctx));
    expect(log.args).toContain('log');
    expect(log.timeoutMs).toBe(DIFF_TIMEOUT_MS);

    const files = await capture(() => getCommitFiles(ctx, 'HEAD'));
    expect(files.args).toContain('show');
    expect(files.timeoutMs).toBe(DIFF_TIMEOUT_MS);

    const commitDiff = await capture(() => getCommitFileDiff(ctx, 'HEAD', 'a.txt'));
    expect(commitDiff.args).toContain('show');
    expect(commitDiff.timeoutMs).toBe(DIFF_TIMEOUT_MS);
  });

  it('#32 --version にもタイムアウトが載る（起動時の無反応を防ぐ）', async () => {
    const cmd = await capture(() => getGitVersion('git', ctx.cwd));
    expect(cmd.args).toContain('--version');
    expect(cmd.timeoutMs).toBe(REV_PARSE_TIMEOUT_MS);
  });
});

describe('書き込み系・通信系にはタイムアウトを載せない', () => {
  it('#12 switch / #14 switch -c / #35 merge', async () => {
    const sw = await capture(() => switchBranch(ctx, 'main'));
    expect(sw.args).toContain('switch');
    expect(sw.timeoutMs).toBeUndefined();

    const create = await capture(() => createBranch(ctx, 'feature', 'main'));
    expect(create.timeoutMs).toBeUndefined();

    const merge = await capture(() => mergeBranch(ctx, 'feature'));
    expect(merge.args).toContain('merge');
    expect(merge.timeoutMs).toBeUndefined();
  });

  it('#22 fetch（通信系は人が待つと決めた操作）', async () => {
    const cmd = await capture(() => fetchRemote(ctx, 'origin'));
    expect(cmd.args).toContain('fetch');
    expect(cmd.timeoutMs).toBeUndefined();
  });
});
