/*
 * ZIP の書き出し（決定 34 の第 2 段階。docs/07-xlsx-cell-merge.md 2 章）。
 *
 * **変えない部品は圧縮済みのバイトをそのまま写す**（展開・再圧縮しない。CRC・方式・日時も元のまま）。
 * 変えた部品だけを、呼び出し側から注入された deflate で圧縮し直す（このパッケージは Node を知らない）。
 *
 * ZIP64 は書かない。ブックの上限（決定 33。100MB）と部品の数は ZIP の 32 bit / 16 bit の欄に収まる。
 * 収まらなければ書かずに失敗を返す。
 */

import { METHOD_DEFLATE, type ZipArchive, type ZipEntry } from '../zip/reader.js';

/** raw deflate（zlib のヘッダなし）。core が `node:zlib` の `deflateRawSync` を渡す。 */
export type Deflater = (data: Uint8Array) => Uint8Array;

export type ZipWriteItem =
  /** 元の ZIP の部品を、圧縮済みのバイトのまま写す。 */
  | { readonly kind: 'copy'; readonly entry: ZipEntry }
  /** 新しい中身で書く（deflate する）。 */
  | { readonly kind: 'data'; readonly name: string; readonly data: Uint8Array };

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const LOCAL_SIZE = 30;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
/** 1980-01-01 00:00（DOS 日時の最小値）。新しく書く部品の日時。 */
const DOS_DATE_1980 = 0x0021;
const MAX_U32 = 0xffffffff;

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = (CRC_TABLE[(c ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}

class Out {
  readonly #chunks: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    this.#chunks.push(bytes);
    this.length += bytes.length;
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.#chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

class Header {
  readonly bytes: Uint8Array;
  readonly #view: DataView;
  #at = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.#view = new DataView(this.bytes.buffer);
  }

  u16(v: number): this {
    this.#view.setUint16(this.#at, v, true);
    this.#at += 2;
    return this;
  }

  u32(v: number): this {
    this.#view.setUint32(this.#at, v >>> 0, true);
    this.#at += 4;
    return this;
  }

  raw(b: Uint8Array): this {
    this.bytes.set(b, this.#at);
    this.#at += b.length;
    return this;
  }
}

interface Written {
  readonly name: Uint8Array;
  readonly flags: number;
  readonly method: number;
  readonly time: number;
  readonly date: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly offset: number;
}

export type ZipWriteResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: 'too-large' | 'broken' };

/** 部品を並べた順に書く。写す部品は元の ZIP（archive）から読む。 */
export function writeZip(archive: ZipArchive, items: readonly ZipWriteItem[], deflate: Deflater): ZipWriteResult {
  const src = archive.bytes;
  const out = new Out();
  const written: Written[] = [];
  const encoder = new TextEncoder();

  for (const item of items) {
    const offset = out.length;
    let entry: Omit<Written, 'offset'>;
    let body: Uint8Array;
    if (item.kind === 'copy') {
      const e = item.entry;
      const at = e.localHeaderOffset;
      if (u16(src, at) !== (SIG_LOCAL & 0xffff) || u16(src, at + 2) !== SIG_LOCAL >>> 16) return { ok: false, reason: 'broken' };
      const nameLen = u16(src, at + 26);
      const extraLen = u16(src, at + 28);
      const dataStart = at + LOCAL_SIZE + nameLen + extraLen;
      if (dataStart + e.compressedSize > src.length) return { ok: false, reason: 'broken' };
      body = src.subarray(dataStart, dataStart + e.compressedSize);
      entry = {
        name: src.subarray(at + LOCAL_SIZE, at + LOCAL_SIZE + nameLen),
        // サイズは中央ディレクトリから取って局所ヘッダに書くので、データ記述子の印は落とす
        flags: e.flags & ~FLAG_DATA_DESCRIPTOR,
        method: e.method,
        time: u16(src, at + 10),
        date: u16(src, at + 12),
        crc: e.crc32,
        compressedSize: e.compressedSize,
        size: e.uncompressedSize,
      };
    } else {
      body = deflate(item.data);
      const name = encoder.encode(item.name);
      entry = {
        name,
        flags: name.some((c) => c >= 0x80) ? FLAG_UTF8 : 0,
        method: METHOD_DEFLATE,
        time: 0,
        date: DOS_DATE_1980,
        crc: crc32(item.data),
        compressedSize: body.length,
        size: item.data.length,
      };
    }
    if (entry.compressedSize > MAX_U32 || entry.size > MAX_U32 || offset > MAX_U32) return { ok: false, reason: 'too-large' };
    const local = new Header(LOCAL_SIZE + entry.name.length)
      .u32(SIG_LOCAL)
      .u16(20)
      .u16(entry.flags)
      .u16(entry.method)
      .u16(entry.time)
      .u16(entry.date)
      .u32(entry.crc)
      .u32(entry.compressedSize)
      .u32(entry.size)
      .u16(entry.name.length)
      .u16(0)
      .raw(entry.name);
    out.push(local.bytes);
    out.push(body);
    written.push({ ...entry, offset });
  }

  const cdOffset = out.length;
  for (const w of written) {
    const central = new Header(46 + w.name.length)
      .u32(SIG_CENTRAL)
      .u16(20)
      .u16(20)
      .u16(w.flags)
      .u16(w.method)
      .u16(w.time)
      .u16(w.date)
      .u32(w.crc)
      .u32(w.compressedSize)
      .u32(w.size)
      .u16(w.name.length)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(0)
      .u32(w.offset)
      .raw(w.name);
    out.push(central.bytes);
  }
  const cdSize = out.length - cdOffset;
  if (written.length > 0xffff || cdOffset > MAX_U32) return { ok: false, reason: 'too-large' };
  out.push(
    new Header(22)
      .u32(SIG_EOCD)
      .u16(0)
      .u16(0)
      .u16(written.length)
      .u16(written.length)
      .u32(cdSize)
      .u32(cdOffset)
      .u16(0).bytes,
  );
  return { ok: true, bytes: out.concat() };
}
