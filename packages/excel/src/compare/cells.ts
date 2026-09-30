/*
 * セル 1 つの見え方と、新旧のセルが「同じ」か（決定 33）。
 *
 * **比べるのは値と数式だけ。** 書式（s 属性）だけの違いは M1 では変更に数えない。
 * 文字列は「共有文字列か・インライン文字列か・数式の文字列結果か」を問わず、本文で比べる
 * （保存したツールによって同じ文字列の持ち方が変わることがあるため）。
 */

import { formatGeneral } from '../format/general.js';
import { builtinFormat } from '../format/builtin.js';
import { isoToSerial } from '../format/date.js';
import { formatNumber, formatTextValue } from '../format/numFmt.js';
import type { StyleTable } from '../style/styles.js';
import type { Workbook } from '../model/types.js';
import { DEFAULT_LIMITS } from '../limits.js';
import {
  CELL_BLANK,
  CELL_BOOL,
  CELL_DATE,
  CELL_ERROR,
  CELL_FORMULA_STR,
  CELL_INLINE,
  CELL_NUMBER,
  CELL_SHARED,
  type CellData,
} from '../model/types.js';

/** 値の大分類（比較用）。文字列系は 1 つにまとめる。 */
export const VALUE_EMPTY = 0;
export const VALUE_NUMBER = 1;
export const VALUE_TEXT = 2;
export const VALUE_BOOL = 3;
export const VALUE_ERROR = 4;
export const VALUE_DATE = 5;

export function valueClass(cell: CellData | undefined): number {
  if (cell === undefined) return VALUE_EMPTY;
  switch (cell.kind) {
    case CELL_NUMBER:
      return VALUE_NUMBER;
    case CELL_SHARED:
    case CELL_INLINE:
    case CELL_FORMULA_STR:
      return VALUE_TEXT;
    case CELL_BOOL:
      return VALUE_BOOL;
    case CELL_ERROR:
      return VALUE_ERROR;
    case CELL_DATE:
      return VALUE_DATE;
    default:
      return VALUE_EMPTY;
  }
}

/** 文字列系のセルの本文。 */
export function cellString(cell: CellData, sst: readonly string[]): string {
  if (cell.kind === CELL_SHARED) return sst[cell.num] ?? '';
  return cell.text ?? '';
}

/** 画面に出す文字（M1 は「標準」書式だけ）。 */
export function displayText(cell: CellData | undefined, sst: readonly string[]): string {
  if (cell === undefined) return '';
  switch (cell.kind) {
    case CELL_NUMBER:
      return formatGeneral(cell.num);
    case CELL_SHARED:
    case CELL_INLINE:
    case CELL_FORMULA_STR:
    case CELL_ERROR:
    case CELL_DATE:
      return cellString(cell, sst);
    case CELL_BOOL:
      return cell.num !== 0 ? 'TRUE' : 'FALSE';
    default:
      return '';
  }
}

/** 表示形式を当てるのに要るもの（ブックごと）。 */
export interface FormatContext {
  readonly sst: readonly string[];
  readonly styles: StyleTable | null;
  readonly date1904: boolean;
}

export function formatContextOf(book: Workbook | null): FormatContext {
  return { sst: book?.sst ?? [], styles: book?.styles ?? null, date1904: book?.date1904 ?? false };
}

/** セルの表示形式の文字列。書式が無い・「標準」なら null。 */
export function formatCodeOf(cell: CellData, ctx: FormatContext): string | null {
  if (ctx.styles === null) return null;
  const style = ctx.styles.cells[cell.style];
  if (style === undefined) return null;
  const code = style.numFmtCode ?? builtinFormat(style.numFmtId);
  if (code === null || code.trim().toLowerCase() === 'general') return null;
  // 長すぎる表示形式は解釈しない（Excel 自身の上限は 255 字。0 を数百万個並べた形で巨大な文字を作らせない）
  return code.length > DEFAULT_LIMITS.maxFormatCode ? null : code;
}

/**
 * 画面に送る表示文字を切り詰める（1 セルの文字が数 MB あっても、ページに何千個も載せない）。
 * 全文は値バー（cellDetail）で読める。
 */
export function clipText(text: string, max = DEFAULT_LIMITS.maxCellText): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * 画面に出す文字（M3: 表示形式を当てる）。**比較には使わない**（比較は生の値。cellsEqual）。
 * 表示形式を解釈できなければ「標準」で出す。
 */
export function formattedText(cell: CellData | undefined, ctx: FormatContext): string {
  if (cell === undefined) return '';
  const code = formatCodeOf(cell, ctx);
  if (code === null) return displayText(cell, ctx.sst);
  switch (cell.kind) {
    case CELL_NUMBER:
      return formatNumber(cell.num, code, ctx.date1904) ?? formatGeneral(cell.num);
    case CELL_DATE: {
      const serial = isoToSerial(cell.text ?? '', ctx.date1904);
      return serial === null ? (cell.text ?? '') : (formatNumber(serial, code, ctx.date1904) ?? (cell.text ?? ''));
    }
    case CELL_SHARED:
    case CELL_INLINE:
    case CELL_FORMULA_STR: {
      const text = cellString(cell, ctx.sst);
      return formatTextValue(text, code) ?? text;
    }
    default:
      return displayText(cell, ctx.sst);
  }
}

/** 値バーに出す生の値（数値は丸めない）。 */
export function rawText(cell: CellData | undefined, sst: readonly string[]): string {
  if (cell === undefined) return '';
  if (cell.kind === CELL_NUMBER) return String(cell.num);
  return displayText(cell, sst);
}

/** 値・数式が空（書式だけのセル・セル無し）か。 */
export function isEmptyCell(cell: CellData | undefined): boolean {
  return cell === undefined || (cell.kind === CELL_BLANK && cell.formula === null);
}

export function cellsEqual(
  a: CellData | undefined,
  sstA: readonly string[],
  b: CellData | undefined,
  sstB: readonly string[],
): boolean {
  const emptyA = isEmptyCell(a);
  const emptyB = isEmptyCell(b);
  if (emptyA || emptyB) return emptyA && emptyB;
  if (a === undefined || b === undefined) return false;
  if ((a.formula ?? '') !== (b.formula ?? '')) return false;
  const ca = valueClass(a);
  if (ca !== valueClass(b)) return false;
  switch (ca) {
    case VALUE_NUMBER:
    case VALUE_BOOL:
      return a.num === b.num || (Number.isNaN(a.num) && Number.isNaN(b.num));
    case VALUE_TEXT:
      return cellString(a, sstA) === cellString(b, sstB);
    case VALUE_ERROR:
    case VALUE_DATE:
      return (a.text ?? '') === (b.text ?? '');
    default:
      return true;
  }
}

/** 列の昇順に並んだ 2 行のセルを突き合わせ、値が違う列を返す。 */
export function changedColumns(
  a: readonly CellData[] | undefined,
  sstA: readonly string[],
  b: readonly CellData[] | undefined,
  sstB: readonly string[],
  limit = Number.POSITIVE_INFINITY,
): number[] {
  const out: number[] = [];
  const ca = a ?? [];
  const cb = b ?? [];
  let i = 0;
  let j = 0;
  while ((i < ca.length || j < cb.length) && out.length < limit) {
    const x = ca[i];
    const y = cb[j];
    if (x !== undefined && (y === undefined || x.col < y.col)) {
      if (!isEmptyCell(x)) out.push(x.col);
      i += 1;
    } else if (y !== undefined && (x === undefined || y.col < x.col)) {
      if (!isEmptyCell(y)) out.push(y.col);
      j += 1;
    } else if (x !== undefined && y !== undefined) {
      if (!cellsEqual(x, sstA, y, sstB)) out.push(x.col);
      i += 1;
      j += 1;
    } else {
      break;
    }
  }
  return out;
}

/**
 * 2 行の似かた（0〜1）。値のある列のうち、両側で同じ値の列の割合（多いほうの列数で割る）。
 * 両方とも空なら 1。
 */
export function rowSimilarity(
  a: readonly CellData[] | undefined,
  sstA: readonly string[],
  b: readonly CellData[] | undefined,
  sstB: readonly string[],
): number {
  const ca = a ?? [];
  const cb = b ?? [];
  let na = 0;
  let nb = 0;
  let equal = 0;
  let i = 0;
  let j = 0;
  while (i < ca.length || j < cb.length) {
    const x = ca[i];
    const y = cb[j];
    if (x !== undefined && (y === undefined || x.col < y.col)) {
      if (!isEmptyCell(x)) na += 1;
      i += 1;
    } else if (y !== undefined && (x === undefined || y.col < x.col)) {
      if (!isEmptyCell(y)) nb += 1;
      j += 1;
    } else if (x !== undefined && y !== undefined) {
      const ex = !isEmptyCell(x);
      const ey = !isEmptyCell(y);
      if (ex) na += 1;
      if (ey) nb += 1;
      if (ex && ey && cellsEqual(x, sstA, y, sstB)) equal += 1;
      i += 1;
      j += 1;
    } else {
      break;
    }
  }
  const most = Math.max(na, nb);
  return most === 0 ? 1 : equal / most;
}

/** 行の中で列 `col` のセルを二分探索で引く。 */
export function cellAt(cells: readonly CellData[] | undefined, col: number): CellData | undefined {
  if (cells === undefined) return undefined;
  let lo = 0;
  let hi = cells.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cells[mid];
    if (c === undefined) return undefined;
    if (c.col === col) return c;
    if (c.col < col) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}
