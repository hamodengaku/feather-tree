/*
 * テスト用の ZIP 書き出し。**Node を使わない**（このパッケージの tsconfig は Node の型を入れていない）。
 *
 * 要素は既定で stored（無圧縮）。`method: 8` を指定すると「deflate のつもりの生データ」を入れるので、
 * 読み出し側には恒等写像の偽 inflater を渡して検証する（本物の deflate は core のテストで通す）。
 */

export interface ZipInput {
  readonly name: string;
  readonly data: Uint8Array | string;
  readonly method?: number;
  readonly flags?: number;
  /** 中央ディレクトリに書く展開後サイズを偽る（ZIP 爆弾の再現）。 */
  readonly declaredSize?: number;
  /** ZIP64 の拡張欄でサイズを書く。 */
  readonly zip64?: boolean;
}

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
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

class Writer {
  readonly parts: number[] = [];

  u8(v: number): void {
    this.parts.push(v & 0xff);
  }

  u16(v: number): void {
    this.u8(v);
    this.u8(v >>> 8);
  }

  u32(v: number): void {
    this.u16(v & 0xffff);
    this.u16(v >>> 16);
  }

  u64(v: number): void {
    this.u32(v % 0x100000000);
    this.u32(Math.floor(v / 0x100000000));
  }

  bytes(b: Uint8Array): void {
    for (const x of b) this.parts.push(x);
  }

  get length(): number {
    return this.parts.length;
  }
}

export interface ZipOptions {
  /**
   * 本物の deflate（raw）。渡すと method を指定していない要素を圧縮して method 8 で書く。
   * excel パッケージのテストは Node を使わないので渡さない。core のテストが `deflateRawSync` を渡す。
   */
  readonly deflate?: (data: Uint8Array) => Uint8Array;
}

export function buildZip(inputs: readonly ZipInput[], options: ZipOptions = {}): Uint8Array {
  const w = new Writer();
  const central = new Writer();
  for (const input of inputs) {
    const original = typeof input.data === 'string' ? encoder.encode(input.data) : input.data;
    const name = encoder.encode(input.name);
    const compress = input.method === undefined && options.deflate !== undefined;
    const method = compress ? 8 : (input.method ?? 0);
    const data = compress && options.deflate !== undefined ? options.deflate(original) : original;
    const flags = (input.flags ?? 0) | 0x0800;
    const crc = crc32(original);
    const size = input.declaredSize ?? original.length;
    const offset = w.length;

    // ローカルヘッダ
    w.u32(0x04034b50);
    w.u16(20);
    w.u16(flags);
    w.u16(method);
    w.u16(0);
    w.u16(0);
    w.u32(crc);
    w.u32(data.length);
    w.u32(size);
    w.u16(name.length);
    w.u16(0);
    w.bytes(name);
    w.bytes(data);

    // 中央ディレクトリ
    const extra = new Writer();
    if (input.zip64 === true) {
      extra.u16(0x0001);
      extra.u16(24);
      extra.u64(size);
      extra.u64(data.length);
      extra.u64(offset);
    }
    central.u32(0x02014b50);
    central.u16(45);
    central.u16(20);
    central.u16(flags);
    central.u16(method);
    central.u16(0);
    central.u16(0);
    central.u32(crc);
    central.u32(input.zip64 === true ? 0xffffffff : data.length);
    central.u32(input.zip64 === true ? 0xffffffff : size);
    central.u16(name.length);
    central.u16(extra.length);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u32(0);
    central.u32(input.zip64 === true ? 0xffffffff : offset);
    central.bytes(name);
    central.bytes(Uint8Array.from(extra.parts));
  }
  const cdOffset = w.length;
  w.bytes(Uint8Array.from(central.parts));
  // EOCD
  w.u32(0x06054b50);
  w.u16(0);
  w.u16(0);
  w.u16(inputs.length);
  w.u16(inputs.length);
  w.u32(central.length);
  w.u32(cdOffset);
  w.u16(0);
  return Uint8Array.from(w.parts);
}

/** 恒等写像の偽 inflater。上限を超えたら too-large。 */
export function identityInflater(data: Uint8Array, max: number): { ok: true; data: Uint8Array } | { ok: false; reason: 'too-large' } {
  if (data.length > max) return { ok: false, reason: 'too-large' };
  return { ok: true, data: data.slice() };
}
