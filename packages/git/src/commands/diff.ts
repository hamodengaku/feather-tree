import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitCancelledError, GitCommandError } from '../execution/errors.js';
import { DIFF_EXTRA, READ_PREFIX } from '../execution/gitEnvironment.js';
import { DIFF_TIMEOUT_MS, runGitText } from '../execution/spawnGit.js';
import { buildAddedFileDiff, looksBinary, parseUnifiedDiff } from '../parsing/diff.js';
import type { FileDiff } from '../model/types.js';
import type { GitContext } from './context.js';

export interface DiffOptions {
  readonly contextLines?: number;
  readonly maxLines?: number;
}

/**
 * 対応表 #18 / #19: 1 ファイルの diff。
 *
 * 一覧表示のために全ファイルの diff を取ることは絶対にしない。
 * 選択された 1 件に対してのみ実行する（docs/01-architecture.md 4 章）。
 */
export async function getFileDiff(
  ctx: GitContext,
  path: string,
  staged: boolean,
  options: DiffOptions = {},
): Promise<FileDiff | null> {
  const args = [
    ...READ_PREFIX,
    'diff',
    ...DIFF_EXTRA,
    `--unified=${options.contextLines ?? 3}`,
  ];
  if (staged) args.push('--cached');
  args.push('--', path);

  const { exit, stdout } = await runGitText(
    // 1 ファイル分の diff なので本来は一瞬。LFS の smudge フィルタが絡むと
    // 孫プロセス待ちで返らなくなることがあるため上限を置く。
    { gitPath: ctx.gitPath, cwd: ctx.cwd, args, timeoutMs: DIFF_TIMEOUT_MS },
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['diff'], exit.code, exit.stderr);

  const files = parseUnifiedDiff(stdout, options.maxLines === undefined ? {} : { maxLines: options.maxLines });
  return files[0] ?? null;
}

/**
 * 未追跡ファイルの表示内容。
 *
 * 未追跡ファイルには diff が存在しない。`git diff --no-index` は呼ばない
 * （プロセスが増え、挙動も不安定）。ファイルを直接読んで全行追加として扱う。
 *
 * **ここには timeoutMs が無い。** git を起動しないので spawnGit のタイマーが存在しない。
 * 代わりに readFile へ AbortSignal を渡し、他の操作と同じように利用者のキャンセルで
 * 抜けられるようにしている（切断されたネットワークドライブ上のファイルで固まらないため）。
 * 中断時の例外は git 層の他の API と揃えて GitCancelledError に寄せる。
 */
export async function getUntrackedFileDiff(
  ctx: GitContext,
  path: string,
  options: DiffOptions = {},
): Promise<FileDiff> {
  const absolute = join(ctx.cwd, path);
  let buf: Buffer;
  try {
    buf = await readFile(absolute, ctx.signal === undefined ? {} : { signal: ctx.signal });
  } catch (err) {
    if (ctx.signal?.aborted === true) throw new GitCancelledError();
    throw err;
  }

  if (looksBinary(buf)) {
    return { path, oldPath: null, binary: true, hunks: [], truncated: false, preamble: [] };
  }

  return buildAddedFileDiff(
    path,
    buf.toString('utf8'),
    options.maxLines === undefined ? {} : { maxLines: options.maxLines },
  );
}
