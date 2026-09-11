import { GitCommandError } from '../execution/errors.js';
import { READ_PREFIX, WRITE_PREFIX } from '../execution/gitEnvironment.js';
import { runGitText } from '../execution/spawnGit.js';
import { parseRefList } from '../parsing/refList.js';
import type { BranchRef } from '../model/types.js';
import type { GitContext } from './context.js';

const FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(committerdate:iso-strict)',
  '%(contents:subject)',
].join('%1f');

/** 対応表 #3: ローカル・リモートのブランチ一覧。 */
export async function listBranches(ctx: GitContext): Promise<BranchRef[]> {
  const { exit, stdout } = await runGitText(
    {
      gitPath: ctx.gitPath,
      cwd: ctx.cwd,
      args: [...READ_PREFIX, 'for-each-ref', `--format=${FORMAT}`, 'refs/heads', 'refs/remotes'],
    },
    ctx.signal,
  );

  if (exit.code !== 0) throw new GitCommandError(['for-each-ref'], exit.code, exit.stderr);
  return parseRefList(stdout);
}

/** 対応表 #12: ブランチ切替。 */
export async function switchBranch(ctx: GitContext, branchName: string): Promise<void> {
  const { exit } = await runGitText(
    { gitPath: ctx.gitPath, cwd: ctx.cwd, args: [...WRITE_PREFIX, 'switch', branchName] },
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['switch'], exit.code, exit.stderr);
}

/** 対応表 #14: ブランチを作成して切替。push は行わない。 */
export async function createBranch(ctx: GitContext, name: string, startPoint: string): Promise<void> {
  const { exit } = await runGitText(
    { gitPath: ctx.gitPath, cwd: ctx.cwd, args: [...WRITE_PREFIX, 'switch', '-c', name, startPoint] },
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['switch', '-c'], exit.code, exit.stderr);
}

/**
 * 対応表 #35: 現在のブランチへ <branchName> をマージする。
 *
 * fast-forward を禁止しない（`--no-ff` を付けない）。git の既定に従う。
 * コンフリクトは exit != 0 で返るので、呼び出し側でエラーとして扱う
 * （自動 abort はしない。競合ファイルは作業ツリーに残す）。
 */
export async function mergeBranch(ctx: GitContext, branchName: string): Promise<void> {
  const { exit } = await runGitText(
    { gitPath: ctx.gitPath, cwd: ctx.cwd, args: [...WRITE_PREFIX, 'merge', branchName] },
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['merge'], exit.code, exit.stderr);
}
