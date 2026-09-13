import { GitCommandError } from '../execution/errors.js';
import { WRITE_PREFIX } from '../execution/gitEnvironment.js';
import { runGitText, runGitWithProgress, type GitExit } from '../execution/spawnGit.js';
import type { GitContext } from './context.js';

/*
 * シャロークローンを完全なリポジトリに戻す（対応表 #40 / #41）。今の使い手は大規模クローンだけ。
 * ctx.cwd はリポジトリルート。順番は必ず #40 → #41。
 */

/** `--depth` が暗黙に付けた `--single-branch` を外す値。 */
export const FETCH_ALL_BRANCHES_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';

/**
 * 対応表 #40: `config remote.origin.fetch +refs/heads/*:refs/remotes/origin/*`。
 * これを先にしないと、#41 は既定ブランチ 1 本分の履歴しか取らない。
 */
export async function setFetchAllBranches(ctx: GitContext): Promise<GitExit> {
  const { exit } = await runGitText(
    {
      gitPath: ctx.gitPath,
      cwd: ctx.cwd,
      args: [...WRITE_PREFIX, 'config', 'remote.origin.fetch', FETCH_ALL_BRANCHES_REFSPEC],
    },
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['config'], exit.code, exit.stderr);
  return exit;
}

/**
 * 対応表 #41: `fetch --progress --unshallow origin`。
 * 完全なリポジトリに対して打つと git が失敗する。呼び出し側が `.git/shallow` の有無で飛ばす。
 */
export async function fetchUnshallow(ctx: GitContext, onProgress: (line: string) => void): Promise<GitExit> {
  const exit = await runGitWithProgress(
    { gitPath: ctx.gitPath, cwd: ctx.cwd, args: [...WRITE_PREFIX, 'fetch', '--progress', '--unshallow', 'origin'] },
    onProgress,
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['fetch'], exit.code, exit.stderr);
  return exit;
}
