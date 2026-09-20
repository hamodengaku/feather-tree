import { getGitVersion, type GitVersion } from '@feathertree/git';

/** `--pathspec-from-file` が使える最小バージョン（docs/02-git-command-map.md）。 */
export const MIN_GIT_MAJOR = 2;
export const MIN_GIT_MINOR = 25;

/**
 * `git stash push --staged`（対応表 #27）が使える最小バージョン。
 *
 * **最低要求（2.25）は上げない。** `--staged` を必要とするのは Stash 保存モードの
 * 保存だけで、他の機能は 2.25 で動く。古い git では保存ボタンだけを止めて理由を出す
 * （決定 31）。代わりの手（素の `stash push` を打つ）に倒さないのは、
 * それが「ステージしたものだけ」という要件を満たさないため——黙って別の意味の
 * 操作をするより、できないと言うほうが正しい（決定 6）。
 */
export const MIN_STAGED_STASH_MAJOR = 2;
export const MIN_STAGED_STASH_MINOR = 35;

/** そのバージョンで `stash push --staged` が使えるか。 */
export function supportsStagedStash(version: GitVersion | null): boolean {
  if (version === null) return false;
  if (version.major > MIN_STAGED_STASH_MAJOR) return true;
  return version.major === MIN_STAGED_STASH_MAJOR && version.minor >= MIN_STAGED_STASH_MINOR;
}

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
