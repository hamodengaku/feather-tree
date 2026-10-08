import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandFor } from '../execution/gitCommand.js';
import { GitCancelledError, GitCommandError, WorktreeFileLockedError } from '../execution/errors.js';
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
    text.includes('invalid object name') ||
    // コミットが 1 つも無いリポジトリの HEAD:<path>
    text.includes('not a valid object name')
  );
}

/**
 * #49 用の「HEAD にそのパスが無い」。`isMissingPath` より狭く取る。
 *
 * `cat-file --filters` は smudge（git-lfs）の失敗もここに流れてくる。その文面は
 * `<path>: smudge filter lfs failed` のようにパスを含むので、`path ` のような広い語で拾うと
 * 「LFS の実体が取れない」を「HEAD に無い（新規ファイル）」と取り違えて黙ってしまう。
 */
function isMissingInHead(stderr: string): boolean {
  const text = stderr.toLowerCase();
  // フィルタの失敗の定型文（<path>: smudge filter <name> failed）。パスに filter という語が入っていても誤らないよう、
  // 語の有無ではなく定型文で見る
  if (/smudge filter [^ ]+ failed|clean filter [^ ]+ failed|external filter .* failed/.test(text)) return false;
  return (
    text.includes('does not exist in') ||
    text.includes('exists on disk, but not in') ||
    text.includes('not a valid object name') ||
    text.includes('invalid object name')
  );
}

/**
 * #49 の index の段（`:<n>:<path>`）用の「その段が無い」（決定 34）。
 *
 * 削除との衝突・片側だけで追加したファイルでは、未マージでも段が 1 つ欠ける。そのときの文面は
 * `path '<path>' is in the index, but not at stage <n>`。index にそもそも無ければ
 * `does not exist (neither on disk nor in the index)` / `exists on disk, but not in the index`。
 * HEAD 版と同じく、smudge の失敗の定型文は「無い」にしない。
 */
function isMissingInStage(stderr: string): boolean {
  const text = stderr.toLowerCase();
  if (/smudge filter [^ ]+ failed|clean filter [^ ]+ failed|external filter .* failed/.test(text)) return false;
  return (
    text.includes('but not at stage') ||
    text.includes('neither on disk nor in the index') ||
    text.includes('exists on disk, but not in the index')
  );
}

/** 利用者が中止したか（await を挟むと変わるので、式の型の絞り込みに頼らず毎回読む）。 */
function userAborted(ctx: GitContext): boolean {
  return ctx.signal?.aborted === true;
}

/** バイト列の読み出しの結果。上限を超えたら中身を持たずに大きさだけを返す。 */
export type BlobBytes =
  | { readonly kind: 'ok'; readonly bytes: Buffer }
  | { readonly kind: 'too-large'; readonly bytes: number };

export interface BlobBytesOptions {
  /** これを超えたら読むのをやめる（git ならプロセスを落とす）。 */
  readonly maxBytes: number;
}

/**
 * 対応表 #49: HEAD 版の**実体**を読む（Excel 差分用。決定 33）。
 *
 * `show HEAD:<path>`（#48）は blob をそのまま返すので、Git LFS 管理のファイルではポインタしか
 * 得られない。`cat-file --filters` は smudge（git-lfs を含む）と改行変換を通すので、
 * チェックアウトしたときと同じバイト列になる。LFS でないバイナリはそのまま返る。
 *
 * **`--` を置けない理由は #48 と同じ。** トークンは必ず `HEAD:` で始まるので、先頭が `-` になる
 * 余地が無い（`<rev>` は固定文字列で renderer からは渡らない）。
 *
 * **上限を超えたらプロセスを落とす。** 呼び出し側の signal に連結した内側の AbortController を
 * 引き、`killTree` で孫の git-lfs まで止める（LFS の実体をダウンロードしている最中でも止まる）。
 *
 * HEAD にそのパスが無い（新規ファイル・コミットが無いリポジトリ）なら null。
 */
export function readHeadBlobFiltered(
  ctx: GitContext,
  path: string,
  options: BlobBytesOptions,
): Promise<BlobBytes | null> {
  return readBlobFiltered(ctx, 'HEAD', path, options);
}

/**
 * #49 が読む版。`HEAD` か、未マージのときの index の段（決定 34）。
 *   - `base`   … `:1:` 共通祖先
 *   - `ours`   … `:2:` 自分側
 *   - `theirs` … `:3:` 相手側
 */
export type FilteredRevision = 'HEAD' | 'base' | 'ours' | 'theirs';

const FILTERED_SPEC: Record<FilteredRevision, string> = {
  HEAD: 'HEAD:',
  base: ':1:',
  ours: ':2:',
  theirs: ':3:',
};

/**
 * 対応表 #49 の本体。版ごとの違いはトークンの頭と「無い」の文面だけ。
 *
 * トークンは必ず `HEAD:` か `:<n>:` で始まり、頭は上の固定表から引く（renderer からは渡らない）ので、
 * 先頭が `-` になる余地が無い（`--` を置けない理由は #48 と同じ）。
 * その版にそのパスが無ければ null。
 */
export async function readBlobFiltered(
  ctx: GitContext,
  revision: FilteredRevision,
  path: string,
  options: BlobBytesOptions,
): Promise<BlobBytes | null> {
  if (ctx.signal?.aborted === true) throw new GitCancelledError();
  const inner = new AbortController();
  const relay = (): void => inner.abort();
  ctx.signal?.addEventListener('abort', relay, { once: true });

  const chunks: Buffer[] = [];
  let total = 0;
  let overflow = false;
  try {
    const { exit } = await runGitStream(
      commandFor(ctx, [...READ_PREFIX, 'cat-file', '--filters', FILTERED_SPEC[revision] + path], {
        timeoutMs: DIFF_TIMEOUT_MS,
      }),
      {
        push: (chunk: Buffer) => {
          if (overflow) return;
          total += chunk.length;
          if (total > options.maxBytes) {
            overflow = true;
            chunks.length = 0;
            inner.abort();
            return;
          }
          chunks.push(chunk);
        },
        finish: () => undefined,
      },
      inner.signal,
    );
    if (overflow) return { kind: 'too-large', bytes: total };
    if (exit.code !== 0) {
      if (revision === 'HEAD' ? isMissingInHead(exit.stderr) : isMissingInStage(exit.stderr)) return null;
      throw new GitCommandError(['cat-file', '--filters'], exit.code, exit.stderr);
    }
    return { kind: 'ok', bytes: Buffer.concat(chunks) };
  } catch (err) {
    // 上限で自分から止めたときの中断は「大きすぎる」。利用者の中止はそのまま投げる
    if (overflow && !userAborted(ctx)) return { kind: 'too-large', bytes: total };
    throw err;
  } finally {
    ctx.signal?.removeEventListener('abort', relay);
  }
}

/**
 * 作業ツリーのファイルをバイト列のまま読む（**git は 0 プロセス**。Excel 差分の新側。決定 33）。
 *
 * 先に大きさを見て、上限を超えていれば読まない。無ければ null（削除されたファイル）。
 * Excel が読み取りも許さない形で開いている（EBUSY / EPERM）ときは `WorktreeFileLockedError`。
 */
export async function readWorktreeBytes(
  ctx: GitContext,
  path: string,
  options: BlobBytesOptions,
): Promise<BlobBytes | null> {
  const absolute = join(ctx.cwd, path);
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return null;
    if (info.size > options.maxBytes) return { kind: 'too-large', bytes: info.size };
    const bytes = await readFile(absolute, ctx.signal === undefined ? {} : { signal: ctx.signal });
    if (bytes.length > options.maxBytes) return { kind: 'too-large', bytes: bytes.length };
    return { kind: 'ok', bytes };
  } catch (err) {
    if (ctx.signal?.aborted === true) throw new GitCancelledError();
    if (isNotFound(err)) return null;
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw new WorktreeFileLockedError(path, err);
    throw err;
  }
}

/**
 * 作業ツリーのファイルへバイト列をそのまま書く（**git は 0 プロセス**。Excel のコンフリクトの採用。決定 34）。
 *
 * インデックスには触れない（`writeConflictText` と同じ。解決済みにするのは利用者のステージ）。
 * Excel が開いていて書かせてくれない（EBUSY / EPERM）ときは `WorktreeFileLockedError`。
 */
export async function writeWorktreeBytes(ctx: GitContext, path: string, bytes: Uint8Array): Promise<void> {
  try {
    await writeFile(join(ctx.cwd, path), bytes, ctx.signal === undefined ? {} : { signal: ctx.signal });
  } catch (err) {
    if (ctx.signal?.aborted === true) throw new GitCancelledError();
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw new WorktreeFileLockedError(path, err);
    throw err;
  }
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
