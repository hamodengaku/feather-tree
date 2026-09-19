import { commandFor } from '../execution/gitCommand.js';
import { GitCommandError } from '../execution/errors.js';
import { READ_PREFIX } from '../execution/gitEnvironment.js';
import { REF_LIST_TIMEOUT_MS, REV_PARSE_TIMEOUT_MS, runGitText } from '../execution/spawnGit.js';
import type { GitVersion, RepositoryLocation } from '../model/types.js';
import type { GitContext } from './context.js';

/**
 * 対応表 #1: リポジトリを開く（検証）。
 * ルートと .git ディレクトリを 1 回の実行で取得する。
 */
export async function resolveRepository(ctx: GitContext): Promise<RepositoryLocation> {
  const { exit, stdout } = await runGitText(
    commandFor(
      ctx,
      [...READ_PREFIX, 'rev-parse', '--show-toplevel', '--absolute-git-dir'],
      // 切断された UNC / オフラインの OneDrive 上のフォルダを開くと、ここだけが延々と返らない。
      // 本来は一瞬で終わる読み取りなので、短く打ち切って「開けません」と言うほうが正しい。
      { timeoutMs: REV_PARSE_TIMEOUT_MS },
    ),
    ctx.signal,
  );

  if (exit.code !== 0) {
    throw new GitCommandError(['rev-parse', '--show-toplevel'], exit.code, exit.stderr);
  }

  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const root = lines[0];
  const gitDir = lines[1];
  if (root === undefined || gitDir === undefined) {
    throw new GitCommandError(['rev-parse', '--show-toplevel'], exit.code, stdout);
  }

  return { root, gitDir };
}

/** 対応表 #4: リモート名の一覧。 */
export async function listRemotes(ctx: GitContext): Promise<string[]> {
  const { exit, stdout } = await runGitText(
    commandFor(ctx, [...READ_PREFIX, 'remote'], { timeoutMs: REF_LIST_TIMEOUT_MS }),
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['remote'], exit.code, exit.stderr);
  return stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * 対応表 #32: git のバージョン確認（起動時 1 回）。
 *
 * 対応表のタイムアウト表には載っていないが、**ここでは付ける**。
 * リポジトリも作業ツリーも読まない一瞬の処理である一方、起動時に 1 回だけ走り、
 * これが返らないとアプリが起動画面から先へ進まない（利用者から見れば完全な無反応）。
 * 性質としては #1 rev-parse と同じなので同じ値にする。
 */
export async function getGitVersion(gitPath: string, cwd: string, signal?: AbortSignal): Promise<GitVersion> {
  const { exit, stdout } = await runGitText(
    { gitPath, cwd, args: ['--version'], timeoutMs: REV_PARSE_TIMEOUT_MS },
    signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['--version'], exit.code, exit.stderr);

  const raw = stdout.trim();
  const m = /([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(raw);
  return {
    raw,
    major: m === null ? 0 : Number.parseInt(m[1] ?? '0', 10),
    minor: m === null ? 0 : Number.parseInt(m[2] ?? '0', 10),
    patch: m === null ? 0 : Number.parseInt(m[3] ?? '0', 10),
  };
}
