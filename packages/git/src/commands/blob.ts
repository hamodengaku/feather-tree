import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandFor } from '../execution/gitCommand.js';
import { GitCancelledError, GitCommandError } from '../execution/errors.js';
import { READ_PREFIX } from '../execution/gitEnvironment.js';
import { DIFF_TIMEOUT_MS, runGitStream } from '../execution/spawnGit.js';
import { looksBinary } from '../parsing/diff.js';
import type { GitContext } from './context.js';

/**
 * 対応表 #48: blob の全文取得（Unity 展開用。決定 32）。
 *
 * どの版を読むかは 2 通りしかない。
 *   - `'HEAD'` … HEAD のその時点の内容（ステージ済みを見ているときの「変更前」）
 *   - `'index'`… インデックスの内容（未ステージの「変更前」／ステージ済みの「変更後」）
 *
 * **`--` を置けない**（`<rev>:<path>` は 1 トークンで、`show -- HEAD:x` はパス扱いになる）。
 * 代わりに**このトークンは必ず `HEAD:` か `:` で始まる**——`<rev>` はここにある固定文字列で
 * renderer からは渡らないので、先頭が `-` になる余地が構造的に無い
 * （docs/02-git-command-map.md「名前渡しの規則」の注記）。
 */
export type BlobRevision = 'HEAD' | 'index';

export interface BlobText {
  /** バイナリ（先頭に NUL がある）なら null。LFS のポインタは「テキスト」として返る。 */
  readonly text: string | null;
  readonly bytes: number;
}

/**
 * blob を全文取得する。存在しなければ null（新規ファイル・削除済みなど）。
 *
 * **`runGitText` ではなく `runGitStream` を使う。** Unity のシーンは 100MB に
 * なりうるので、Buffer のまま集めて `looksBinary` を先に見る。バイナリなら
 * 文字列化せずに捨てる（一度 UTF-8 にしてから捨てるのは丸損。決定 32 / F-1）。
 */
export async function readBlobText(
  ctx: GitContext,
  revision: BlobRevision,
  path: string,
): Promise<BlobText | null> {
  const spec = (revision === 'HEAD' ? 'HEAD:' : ':') + path;
  const chunks: Buffer[] = [];

  const { exit, result } = await runGitStream(
    commandFor(ctx, [...READ_PREFIX, 'show', spec], { timeoutMs: DIFF_TIMEOUT_MS }),
    {
      push: (chunk: Buffer) => chunks.push(chunk),
      finish: () => Buffer.concat(chunks),
    },
    ctx.signal,
  );

  if (exit.code !== 0) {
    // その版にそのパスが無い（新規ファイル、HEAD が無いリポジトリ、削除済み）。
    // 呼び出し側は「旧側が空」として扱えるので、ここでは失敗にしない
    if (isMissingPath(exit.stderr)) return null;
    throw new GitCommandError(['show'], exit.code, exit.stderr);
  }

  if (looksBinary(result)) return { text: null, bytes: result.length };
  return { text: result.toString('utf8'), bytes: result.length };
}

/**
 * 「その版にそのパスが無い」を表す stderr か。
 *
 * git のメッセージは版によって揺れるので、**語を 1 つに絞らず**複数見る。
 * 取りこぼしても `GitCommandError` になるだけで、誤って成功にはしない。
 */
function isMissingPath(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes('does not exist') ||
    text.includes('exists on disk, but not in') ||
    text.includes('unknown revision') ||
    text.includes('path ') ||
    text.includes('invalid object name')
  );
}

/**
 * 作業ツリーのファイルを全文で読む（**git は 0 プロセス**）。
 *
 * Unity モードの「新側」がこれ。`git show` と違って smudge フィルタも
 * 改行変換も通った後のバイト列、つまり**利用者がエディタで見ているそのもの**を返す。
 * 旧側（`readBlobText`）との食い違いは unity 層の `verifyAlignment` が検査する
 * （docs/02-git-command-map.md「Unity の YAML と blob の全文取得」）。
 *
 * **ここには timeoutMs が無い。** git を起動しないので spawnGit のタイマーが存在しない。
 * 代わりに readFile へ AbortSignal を渡し、切断されたネットワークドライブ上の
 * ファイルで固まらないようにする（`getUntrackedFileDiff` と同じ作法）。
 */
export async function readWorktreeText(ctx: GitContext, path: string): Promise<BlobText | null> {
  let buf: Buffer;
  try {
    buf = await readFile(join(ctx.cwd, path), ctx.signal === undefined ? {} : { signal: ctx.signal });
  } catch (err) {
    if (ctx.signal?.aborted === true) throw new GitCancelledError();
    // 作業ツリーに無い（削除された）。旧側だけで見せられるので失敗にはしない
    if (isNotFound(err)) return null;
    throw err;
  }

  if (looksBinary(buf)) return { text: null, bytes: buf.length };
  return { text: buf.toString('utf8'), bytes: buf.length };
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
