import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitCancelledError } from '../execution/errors.js';
import { looksBinary } from '../parsing/diff.js';
import {
  buildConflictFile,
  joinLines,
  parseConflictMarkers,
  type ConflictParse,
  type ConflictViewOptions,
  type TextLine,
} from '../parsing/conflict.js';
import type { ConflictFile } from '../model/types.js';
import type { GitContext } from './context.js';

/**
 * 未マージファイルの表示と採用（対応表の対象外 — **git を 1 度も起動しない**）。
 *
 * `git diff` は未マージのファイルに対して結合 diff（`diff --cc`）を出す。あれは
 * 「両親のどちらとも違う行」を示すもので、**マーカーの中身は読めない**（対応表 #18 の注記）。
 * 利用者が見たいのは作業ツリーに書かれたマーカーそのものなので、未追跡ファイルの diff
 * （`getUntrackedFileDiff`）と同じ考え方でファイルを直接読む。
 *
 * **ここには timeoutMs が無い。** git を起動しないので spawnGit のタイマーが存在しない。
 * 代わりに readFile / writeFile へ AbortSignal を渡し、他の操作と同じように利用者の
 * キャンセルで抜けられるようにしている。中断時の例外は git 層の他の API と揃えて
 * GitCancelledError に寄せる。
 */

/** 解析だけを返す（採用に使う）。ファイルが無ければ null。 */
export async function readConflictText(
  ctx: GitContext,
  path: string,
): Promise<(ConflictParse & { readonly binary: boolean }) | null> {
  const buf = await readWorktreeFile(ctx, path);
  if (buf === null) return null;
  if (looksBinary(buf)) return { lines: [], blocks: [], malformed: false, binary: true };
  return { ...parseConflictMarkers(buf.toString('utf8')), binary: false };
}

/** 画面に出す形まで組み立てて返す。ファイルが無ければ null（削除との衝突）。 */
export async function readConflictFile(
  ctx: GitContext,
  path: string,
  options: ConflictViewOptions = {},
): Promise<ConflictFile | null> {
  const parsed = await readConflictText(ctx, path);
  if (parsed === null) return null;
  if (parsed.binary) {
    return { path, binary: true, malformed: false, sections: [], truncated: false };
  }
  return buildConflictFile(path, parsed, options);
}

/**
 * 採用の結果を作業ツリーへ書き戻す。
 *
 * インデックスには触れない（未マージのままなので、解決済みにするのは利用者の
 * 「ステージ」操作＝対応表 #5）。**ここで `git add` を代行しない**のは、
 * 素の git の手順（編集 → add）と 1:1 に保つため（決定 6）。
 */
export async function writeConflictText(
  ctx: GitContext,
  path: string,
  lines: readonly TextLine[],
): Promise<void> {
  const absolute = join(ctx.cwd, path);
  try {
    await writeFile(
      absolute,
      joinLines(lines),
      ctx.signal === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', signal: ctx.signal },
    );
  } catch (err) {
    if (ctx.signal?.aborted === true) throw new GitCancelledError();
    throw err;
  }
}

/** 作業ツリーのファイルを読む。存在しなければ null（削除との衝突では実体が無い）。 */
async function readWorktreeFile(ctx: GitContext, path: string): Promise<Buffer | null> {
  const absolute = join(ctx.cwd, path);
  try {
    return await readFile(absolute, ctx.signal === undefined ? {} : { signal: ctx.signal });
  } catch (err) {
    if (ctx.signal?.aborted === true) throw new GitCancelledError();
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw err;
  }
}
