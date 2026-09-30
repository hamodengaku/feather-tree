/*
 * ZIP の読み取り（決定 33）。xlsx は ZIP に XML を詰めたもの。
 *
 * 読むのは**中央ディレクトリ**（末尾の目次）。ローカルヘッダのサイズ欄は「データ記述子」形式だと 0 に
 * なるので、サイズと位置は必ず中央ディレクトリから取る。
 *
 * **deflate の展開は自分でやらない。** 呼び出し側から `Inflater` を注入してもらう（core が
 * `node:zlib` の `inflateRawSync` を渡す）。このパッケージを Node から切り離しておくため
 * （`.dependency-cruiser.cjs` の `no-node-in-excel`）。
 *
 * **例外を投げない。** 壊れた ZIP は `{ ok: false }` で返す。ここで投げると
 * 「差分が見られない」ではなく「アプリが落ちる」になる（Unity モードと同じ規則）。
 */

import { decodeUtf8 } from '../text/utf8.js';

export type InflateResult =
  | { readonly ok: true; readonly data: Uint8Array }
  | { readonly ok: false; readonly reason: 'too-large' | 'broken' };

/**
 * raw deflate の展開。**`maxOutputLength` を超えたら展開を止めて `too-large` を返す**こと
 * （宣言サイズを偽った ZIP 爆弾は、宣言を信じると止まらない）。
 */
export type Inflater = (data: Uint8Array, maxOutputLength: number) => InflateResult;

export interface ZipEntry {
  /** ZIP 内の名前（そのまま）。 */
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

export interface ZipArchive {
  readonly bytes: Uint8Array;
  /** 小文字にした名前 → 要素（OPC の部品名は大文字小文字を区別しない）。 */
  readonly entries: ReadonlyMap<string, ZipEntry>;
}

export type ZipOpenResult =
  | { readonly ok: true; readonly archive: ZipArchive }
  | { readonly ok: false; readonly reason: 'not-zip' | 'broken' };

export type ZipReadResult =
  | { readonly ok: true; readonly data: Uint8Array }
  | { readonly ok: false; readonly reason: 'too-large' | 'broken' | 'encrypted' | 'unsupported' };

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;

const FLAG_ENCRYPTED = 0x0001;

export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;

function u16(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>> 0;
}

/** 64 bit 値。2^53 を超えるものは ZIP として扱わない（-1 を返す）。 */
function u64(b: Uint8Array, at: number): number {
  const lo = u32(b, at);
  const hi = u32(b, at + 4);
  if (hi >= 0x200000) return -1;
  return hi * 0x100000000 + lo;
}

export function openZip(bytes: Uint8Array): ZipOpenResult {
  const eocd = findEocd(bytes);
  if (eocd < 0) return { ok: false, reason: 'not-zip' };

  let count = u16(bytes, eocd + 10);
  let cdSize = u32(bytes, eocd + 12);
  let cdOffset = u32(bytes, eocd + 16);

  // ZIP64: 32 bit 欄が飽和していれば、直前のロケータから ZIP64 の EOCD を引く
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || u32(bytes, locator) !== SIG_ZIP64_LOCATOR) return { ok: false, reason: 'broken' };
    const z64 = u64(bytes, locator + 8);
    if (z64 < 0 || z64 + 56 > bytes.length || u32(bytes, z64) !== SIG_ZIP64_EOCD) {
      return { ok: false, reason: 'broken' };
    }
    count = u64(bytes, z64 + 32);
    cdSize = u64(bytes, z64 + 40);
    cdOffset = u64(bytes, z64 + 48);
    if (count < 0 || cdSize < 0 || cdOffset < 0) return { ok: false, reason: 'broken' };
  }

  if (cdOffset + cdSize > bytes.length) return { ok: false, reason: 'broken' };

  const entries = new Map<string, ZipEntry>();
  let at = cdOffset;
  const end = cdOffset + cdSize;
  for (let i = 0; i < count; i += 1) {
    if (at + CENTRAL_SIZE > end || u32(bytes, at) !== SIG_CENTRAL) return { ok: false, reason: 'broken' };
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const crc32 = u32(bytes, at + 16);
    let compressedSize = u32(bytes, at + 20);
    let uncompressedSize = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    let localHeaderOffset = u32(bytes, at + 42);
    const nameStart = at + CENTRAL_SIZE;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > end) return { ok: false, reason: 'broken' };

    // ZIP64 の拡張欄（0x0001）。飽和している欄だけが、この順で入っている
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const z = readZip64Extra(bytes, extraStart, extraStart + extraLength, {
        uncompressed: uncompressedSize === 0xffffffff,
        compressed: compressedSize === 0xffffffff,
        offset: localHeaderOffset === 0xffffffff,
      });
      if (z === null) return { ok: false, reason: 'broken' };
      if (z.uncompressed !== null) uncompressedSize = z.uncompressed;
      if (z.compressed !== null) compressedSize = z.compressed;
      if (z.offset !== null) localHeaderOffset = z.offset;
    }

    const name = decodeUtf8(bytes, nameStart, extraStart);
    entries.set(name.toLowerCase(), {
      name,
      method,
      flags,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    at = next;
  }

  return { ok: true, archive: { bytes, entries } };
}

/**
 * 要素を 1 つ取り出す。
 *
 * `maxOutput` は呼び出し側が「要素の上限」と「ブック全体の残り予算」の小さいほうを渡す。
 * **宣言サイズがそれを超えていれば展開を始めない**（宣言が正直な大きいファイルを早く断る）。
 * 宣言が嘘なら `Inflater` 側の上限で止まる。
 */
export function readZipEntry(
  archive: ZipArchive,
  entry: ZipEntry,
  inflate: Inflater,
  maxOutput: number,
): ZipReadResult {
  if ((entry.flags & FLAG_ENCRYPTED) !== 0) return { ok: false, reason: 'encrypted' };
  if (entry.uncompressedSize > maxOutput) return { ok: false, reason: 'too-large' };

  const bytes = archive.bytes;
  const local = entry.localHeaderOffset;
  if (local + LOCAL_SIZE > bytes.length || u32(bytes, local) !== SIG_LOCAL) return { ok: false, reason: 'broken' };
  const dataStart = local + LOCAL_SIZE + u16(bytes, local + 26) + u16(bytes, local + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) return { ok: false, reason: 'broken' };
  const data = bytes.subarray(dataStart, dataEnd);

  if (entry.method === METHOD_STORED) {
    if (entry.compressedSize !== entry.uncompressedSize) return { ok: false, reason: 'broken' };
    return { ok: true, data };
  }
  if (entry.method !== METHOD_DEFLATE) return { ok: false, reason: 'unsupported' };

  let result: InflateResult;
  try {
    result = inflate(data, maxOutput);
  } catch {
    // 注入された関数が約束を破って投げても、ここで止める
    result = { ok: false, reason: 'broken' };
  }
  return result;
}

function findEocd(bytes: Uint8Array): number {
  const last = bytes.length - EOCD_SIZE;
  const first = Math.max(0, last - MAX_COMMENT);
  for (let at = last; at >= first; at -= 1) {
    if (bytes[at] === 0x50 && u32(bytes, at) === SIG_EOCD) {
      // コメント長が末尾と合うものだけを本物とみなす（コメントの中の偽の署名を避ける）
      if (at + EOCD_SIZE + u16(bytes, at + 20) === bytes.length) return at;
    }
  }
  return -1;
}

interface Zip64Want {
  readonly uncompressed: boolean;
  readonly compressed: boolean;
  readonly offset: boolean;
}

interface Zip64Values {
  readonly uncompressed: number | null;
  readonly compressed: number | null;
  readonly offset: number | null;
}

function readZip64Extra(bytes: Uint8Array, start: number, end: number, want: Zip64Want): Zip64Values | null {
  let at = start;
  while (at + 4 <= end) {
    const id = u16(bytes, at);
    const size = u16(bytes, at + 2);
    const body = at + 4;
    if (body + size > end) return null;
    if (id === 0x0001) {
      let p = body;
      const take = (flag: boolean): number | null | undefined => {
        if (!flag) return null;
        if (p + 8 > body + size) return undefined;
        const v = u64(bytes, p);
        p += 8;
        return v < 0 ? undefined : v;
      };
      const uncompressed = take(want.uncompressed);
      const compressed = take(want.compressed);
      const offset = take(want.offset);
      if (uncompressed === undefined || compressed === undefined || offset === undefined) return null;
      return { uncompressed, compressed, offset };
    }
    at = body + size;
  }
  return null;
}
