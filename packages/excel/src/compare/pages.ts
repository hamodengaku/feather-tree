/*
 * 行ページとセルの詳細（決定 33 / EA-4）。
 *
 * renderer には見えている範囲の行だけを渡す。1 行ぶんの片側は「列番号・表示文字・値の大分類・書式」の
 * 並列配列で、セルごとのオブジェクトにしない（構造化クローンを軽くする）。空のセルは載せない。
 */

import { cellAddress } from '../sheet/ref.js';
import type { CellData, SheetData, Workbook } from '../model/types.js';
import {
  cellAt,
  cellsEqual,
  changedColumns,
  clipText,
  formatContextOf,
  formattedText,
  isEmptyCell,
  rawText,
  valueClass,
  type FormatContext,
} from './cells.js';
import type { SheetComparison, WorkbookComparison } from './compare.js';

export interface RowSide {
  /** その側のシートの行番号（0 始まり）。 */
  readonly row: number;
  readonly cols: Int32Array;
  readonly text: string[];
  /** 値の大分類（cells.ts の VALUE_*）。右寄せ（数値）などの見た目に使う。 */
  readonly kind: Uint8Array;
  readonly style: Int32Array;
}

export interface RowPageEntry {
  readonly old: RowSide | null;
  readonly new: RowSide | null;
  /** 値が違う列（揃えた行の両側を比べたもの）。 */
  readonly changedCols: Int32Array;
}

export function buildRowPage(
  comparison: WorkbookComparison,
  sheet: SheetComparison,
  start: number,
  count: number,
  maxColumns: number,
): RowPageEntry[] {
  const out: RowPageEntry[] = [];
  const oldData = sheet.old?.data ?? null;
  const newData = sheet.new?.data ?? null;
  const sstOld = comparison.old?.sst ?? [];
  const sstNew = comparison.new?.sst ?? [];
  const ctxOld = formatContextOf(comparison.old);
  const ctxNew = formatContextOf(comparison.new);
  const end = Math.min(sheet.oldRow.length, start + count);
  for (let i = Math.max(0, start); i < end; i += 1) {
    const o = sheet.oldRow[i] ?? -1;
    const n = sheet.newRow[i] ?? -1;
    const cellsOld = o >= 0 ? oldData?.rows[o]?.cells : undefined;
    const cellsNew = n >= 0 ? newData?.rows[n]?.cells : undefined;
    out.push({
      old: o >= 0 && oldData !== null ? side(o, cellsOld, ctxOld, maxColumns) : null,
      new: n >= 0 && newData !== null ? side(n, cellsNew, ctxNew, maxColumns) : null,
      changedCols: Int32Array.from(changedColumns(cellsOld, sstOld, cellsNew, sstNew)),
    });
  }
  return out;
}

/**
 * 行の片側。値のあるセルに加えて、**書式だけのセル**も載せる（塗りや罫線を描くため。M2）。
 * 表示文字には表示形式を当てる（M3）。
 */
function side(row: number, cells: readonly CellData[] | undefined, ctx: FormatContext, maxColumns: number): RowSide {
  const list = (cells ?? []).filter((c) => c.col < maxColumns && (!isEmptyCell(c) || c.style !== 0));
  return {
    row,
    cols: Int32Array.from(list, (c) => c.col),
    text: list.map((c) => clipText(formattedText(c, ctx))),
    kind: Uint8Array.from(list, (c) => valueClass(c)),
    style: Int32Array.from(list, (c) => c.style),
  };
}

export interface CellSide {
  readonly address: string;
  readonly raw: string;
  readonly display: string;
  readonly kind: number;
  readonly formula: string | null;
}

export interface CellDetail {
  readonly old: CellSide | null;
  readonly new: CellSide | null;
  readonly changed: boolean;
}

export function cellDetail(
  comparison: WorkbookComparison,
  sheet: SheetComparison,
  alignedRow: number,
  col: number,
): CellDetail {
  const o = sheet.oldRow[alignedRow] ?? -1;
  const n = sheet.newRow[alignedRow] ?? -1;
  const oldSide = cellSide(sheet.old?.data ?? null, o, col, formatContextOf(comparison.old));
  const newSide = cellSide(sheet.new?.data ?? null, n, col, formatContextOf(comparison.new));
  const a = o >= 0 ? cellAt(sheet.old?.data?.rows[o]?.cells, col) : undefined;
  const b = n >= 0 ? cellAt(sheet.new?.data?.rows[n]?.cells, col) : undefined;
  const changed = !cellsEqual(a, comparison.old?.sst ?? [], b, comparison.new?.sst ?? []);
  return { old: oldSide, new: newSide, changed };
}

/**
 * 比較に載っていないブックの 1 セル（コンフリクトの共通祖先。決定 34）。
 * 行はそのシートの行番号そのもの（揃えた行ではない）。
 */
export function cellSideIn(book: Workbook | null, data: SheetData | null, row: number, col: number): CellSide | null {
  return cellSide(data, row, col, formatContextOf(book));
}

function cellSide(data: SheetData | null, row: number, col: number, ctx: FormatContext): CellSide | null {
  if (data === null || row < 0) return null;
  const cell = cellAt(data.rows[row]?.cells, col);
  return {
    address: cellAddress(row, col),
    raw: rawText(cell, ctx.sst),
    display: formattedText(cell, ctx),
    kind: valueClass(cell),
    formula: cell?.formula ?? null,
  };
}
