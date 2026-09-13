import { GitCommandError } from '../execution/errors.js';
import { WRITE_PREFIX } from '../execution/gitEnvironment.js';
import { runGitWithProgress, type GitCommand, type GitExit } from '../execution/spawnGit.js';
import type { GitContext } from './context.js';

/*
 * リポジトリのクローン（対応表 #37）。
 *
 * まだリポジトリが無いので、ctx.cwd は**保存先の親フォルダ**を指す（他の操作はリポジトリルート）。
 * 認証は fetch と同じく OS に委譲する（決定 13）。GIT_TERMINAL_PROMPT=0 で資格情報が無ければ即失敗する。
 */

export interface CloneOptions {
  /** クローン元。`--` の後ろに置くので `-` 始まりでもオプションにはならない。 */
  readonly url: string;
  /** 作成するフォルダ。絶対パス、または ctx.cwd からの相対パス。 */
  readonly directory: string;
  /** `--depth 1`。ローカルパスの URL では git が無視する（file:// なら効く）。 */
  readonly shallow: boolean;
  /**
   * チェックアウト中に LFS の実体を落とさない（環境 `GIT_LFS_SKIP_SMUDGE=1`）。
   * 大規模クローンで使い、実体は後で `lfs pull`（#39）が一括で取る。
   */
  readonly skipLfsSmudge?: boolean;
}

/** #37 の実行内容。引数と環境の組み立てを検査できるように切り出してある。 */
export function buildCloneCommand(ctx: GitContext, opts: CloneOptions): GitCommand {
  return {
    gitPath: ctx.gitPath,
    cwd: ctx.cwd,
    args: [
      ...WRITE_PREFIX,
      'clone',
      '--progress',
      ...(opts.shallow ? ['--depth', '1'] : []),
      '--',
      opts.url,
      opts.directory,
    ],
    ...(opts.skipLfsSmudge === true ? { env: { GIT_LFS_SKIP_SMUDGE: '1' } } : {}),
  };
}

/**
 * 対応表 #37: `clone --progress [--depth 1] -- <url> <dir>`。
 *
 * 進捗（Receiving objects: 45% ...）は stderr に CR で上書きしながら出るので、
 * runGitWithProgress で行に切って onProgress へ渡す。
 * 成功時も終了情報（stderr を含む）を返す。呼び出し側が生ログに残すため。
 */
export async function cloneRepository(
  ctx: GitContext,
  opts: CloneOptions,
  onProgress: (line: string) => void,
): Promise<GitExit> {
  const exit = await runGitWithProgress(buildCloneCommand(ctx, opts), onProgress, ctx.signal);
  if (exit.code !== 0) throw new GitCommandError(['clone'], exit.code, exit.stderr);
  return exit;
}
