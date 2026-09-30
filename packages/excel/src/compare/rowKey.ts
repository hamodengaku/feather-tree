/*
 * 行の指紋（決定 33 / EA-2）。行の対応付けは「同じ内容の行」を探す作業なので、行をまるごと
 * 比べる代わりに、値と数式から作った数値を比べる。
 *
 * 53 bit に収めた 2 本の FNV-1a。**衝突しても誤判定にはならない**——対応付けた後に実セルで
 * 比べ直すので、衝突は「揃い方が少し悪くなる」だけで済む（compare.ts）。
 *
 * 共有文字列は添字ではなく**本文**で混ぜる。新旧のファイルで同じ文字列の添字が違うのは普通のこと。
 * 書式（s）は混ぜない（書式だけの変更は数えない）。
 */

import { cellString, isEmptyCell, valueClass, VALUE_BOOL, VALUE_NUMBER, VALUE_TEXT } from './cells.js';
import type { CellData, RowData } from '../model/types.js';

/** 空の行の指紋。align.ts はこの ID をアンカー（一意な行）の候補から外す。 */
export const EMPTY_ROW_KEY = 0;

const scratch = new Float64Array(1);
const scratchWords = new Uint32Array(scratch.buffer);

class Fnv {
  h1 = 0x811c9dc5;
  h2 = 0x01000193 ^ 0x5bd1e995;

  mix(v: number): void {
    this.h1 = Math.imul(this.h1 ^ (v & 0xffff), 0x01000193);
    this.h1 = Math.imul(this.h1 ^ (v >>> 16), 0x01000193);
    this.h2 = Math.imul(this.h2 ^ (v & 0xffff), 0x5bd1e995);
    this.h2 = Math.imul(this.h2 ^ (this.h2 >>> 15), 0x01000193);
  }

  string(s: string): void {
    for (let i = 0; i < s.length; i += 1) this.mix(s.charCodeAt(i));
    this.mix(0xfffe);
  }

  number(n: number): void {
    scratch[0] = n;
    this.mix(scratchWords[0] ?? 0);
    this.mix(scratchWords[1] ?? 0);
  }

  /** 0 以外の 53 bit 整数。 */
  value(): number {
    const v = (this.h1 >>> 0) * 0x200000 + ((this.h2 >>> 0) & 0x1fffff);
    return v === EMPTY_ROW_KEY ? 1 : v;
  }
}

export function rowKey(row: RowData | undefined, sst: readonly string[]): number {
  if (row === undefined) return EMPTY_ROW_KEY;
  const f = new Fnv();
  let any = false;
  for (const cell of row.cells) {
    if (isEmptyCell(cell)) continue;
    any = true;
    mixCell(f, cell, sst);
  }
  return any ? f.value() : EMPTY_ROW_KEY;
}

function mixCell(f: Fnv, cell: CellData, sst: readonly string[]): void {
  f.mix(cell.col);
  const cls = valueClass(cell);
  f.mix(cls);
  if (cls === VALUE_NUMBER || cls === VALUE_BOOL) f.number(cell.num);
  else if (cls === VALUE_TEXT) f.string(cellString(cell, sst));
  else f.string(cell.text ?? '');
  if (cell.formula !== null) f.string(cell.formula);
}
