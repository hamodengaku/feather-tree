import { commandFor } from '../execution/gitCommand.js';
import { GitCommandError } from '../execution/errors.js';
import { WRITE_PREFIX } from '../execution/gitEnvironment.js';
import { runGitText, runGitWithProgress, type GitExit } from '../execution/spawnGit.js';
import type { GitContext } from './context.js';

/*
 * Git LFS（対応表 #38 / #39）。今の使い手はクローンだけ。
 *
 * git-lfs は git のサブコマンドとして呼ぶ（`git lfs ...`）。単体の git-lfs.exe を探しに行かない。
 * git が見つけられる git-lfs だけが、チェックアウト時のフィルタとしても働くため。
 */

export interface LfsVersion {
  /** `git-lfs/3.3.0 (...)`。git-lfs が無ければ null。 */
  readonly version: string | null;
  readonly exit: GitExit;
}

/**
 * 対応表 #38: `lfs version`。
 * 終了コードが 0 以外（`'lfs' is not a git command`）なら version は null。例外にはしない。
 * git 自体が無いときの GitNotFoundError はそのまま投げる。
 */
export async function getLfsVersion(ctx: GitContext): Promise<LfsVersion> {
  const { exit, stdout } = await runGitText(
    commandFor(ctx, [...WRITE_PREFIX, 'lfs', 'version']),
    ctx.signal,
  );
  const line = stdout.trim().split(/\r?\n/)[0] ?? '';
  return { version: exit.code === 0 && line.length > 0 ? line : null, exit };
}

/**
 * 対応表 #39: `lfs pull`。ctx.cwd はリポジトリルート。
 *
 * git-lfs は stdout が端末でないと進捗を出さないので `GIT_LFS_FORCE_PROGRESS=1` を付ける。
 * 進捗（Downloading LFS objects: 45% (12/30), 1.2 GB | 5.0 MB/s）は stderr に出る。
 */
export async function lfsPull(ctx: GitContext, onProgress: (line: string) => void): Promise<GitExit> {
  const exit = await runGitWithProgress(
    commandFor(ctx, [...WRITE_PREFIX, 'lfs', 'pull'], { GIT_LFS_FORCE_PROGRESS: '1' }),
    onProgress,
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['lfs', 'pull'], exit.code, exit.stderr);
  return exit;
}
