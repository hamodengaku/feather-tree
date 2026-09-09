import { GitCommandError } from '../execution/errors.js';
import { READ_PREFIX } from '../execution/gitEnvironment.js';
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
