import { getGitVersion, type GitVersion } from '@feathertree/git';

/** `--pathspec-from-file` が使える最小バージョン（docs/02-git-command-map.md）。 */
export const MIN_GIT_MAJOR = 2;
export const MIN_GIT_MINOR = 25;

export interface GitVersionCheck {
  readonly version: GitVersion;
  readonly supported: boolean;
  readonly warning: string | null;
}

/** 起動時に 1 回だけ実行する。 */
export async function checkGitVersion(
  gitPath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<GitVersionCheck> {
  const version = await getGitVersion(gitPath, cwd, signal);
  const supported =
    version.major > MIN_GIT_MAJOR || (version.major === MIN_GIT_MAJOR && version.minor >= MIN_GIT_MINOR);

  return {
    version,
    supported,
    warning: supported
      ? null
      : `git ${String(version.major)}.${String(version.minor)} は古すぎます。` +
        `${String(MIN_GIT_MAJOR)}.${String(MIN_GIT_MINOR)} 以降へ更新してください。`,
  };
}
