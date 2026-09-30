/*
 * ブックどうしの比較（決定 33）。
 *
 * シートを対応付け（sheetMatch）、対になったシートごとに行を対応付け（align）、
 * 揃えた行ごとに実セルを比べて「同じ / 変更 / 追加 / 削除」を決める。
 *
 * **シート 1 枚ごとに区切れる形（ジェネレータ）**にしてある（workbook.ts と同じ理由）。
 */

import { DEFAULT_LIMITS, type ExcelLimits } from '../limits.js';
import type { SheetData, SheetInfo, Workbook } from '../model/types.js';
import { alignRows } from './align.js';
import { changedColumns, rowSimilarity } from './cells.js';
import { rowKey } from './rowKey.js';
import { matchSheets } from './sheetMatch.js';

/** 揃えた行の状態。 */
export const ROW_SAME = 0;
export const ROW_CHANGED = 1;
export const ROW_ADDED = 2;
export const ROW_REMOVED = 3;

export type SheetMark = 'same' | 'changed' | 'added' | 'removed';

export interface SheetComparison {
  /** 比較の中での添字。IPC のシートの鍵に使う。 */
  readonly index: number;
  readonly old: SheetInfo | null;
  readonly new: SheetInfo | null;
  readonly mark: SheetMark;
  readonly renamed: boolean;
  /** 行の対応付けで予算を超え、位置で対にした区間があった。 */
  readonly positional: boolean;
  /** 揃えた行ごとの旧・新の行番号（無い側は -1）。 */
  readonly oldRow: Int32Array;
  readonly newRow: Int32Array;
  readonly rowState: Uint8Array;
  /** 状態が same でない揃えた行の添字（前後の変更への移動用）。 */
  readonly changedRows: Int32Array;
  readonly changedCells: number;
  readonly addedRows: number;
  readonly removedRows: number;
  readonly changedRowCount: number;
  /** 両側を合わせた列数。 */
  readonly colCount: number;
}

export interface WorkbookComparison {
  readonly old: Workbook | null;
  readonly new: Workbook | null;
  readonly sheets: readonly SheetComparison[];
  /** マクロ（vbaProject.bin）が変わったか。どちらにもマクロが無ければ null。 */
  readonly vbaChanged: boolean | null;
}

export function* compareWorkbooksSteps(
  oldBook: Workbook | null,
  newBook: Workbook | null,
  limits: ExcelLimits = DEFAULT_LIMITS,
): Generator<void, WorkbookComparison> {
  const pairs = matchSheets(oldBook?.sheets ?? [], newBook?.sheets ?? []);
  const sheets: SheetComparison[] = [];
  const sstOld = oldBook?.sst ?? [];
  const sstNew = newBook?.sst ?? [];

  for (const pair of pairs) {
    sheets.push(compareSheet(sheets.length, pair.old, sstOld, pair.new, sstNew, limits));
    yield;
  }

  const vbaOld = oldBook?.vbaCrc ?? null;
  const vbaNew = newBook?.vbaCrc ?? null;
  return {
    old: oldBook,
    new: newBook,
    sheets,
    vbaChanged: vbaOld === null && vbaNew === null ? null : vbaOld !== vbaNew,
  };
}

export function compareWorkbooks(
  oldBook: Workbook | null,
  newBook: Workbook | null,
  limits: ExcelLimits = DEFAULT_LIMITS,
): WorkbookComparison {
  const steps = compareWorkbooksSteps(oldBook, newBook, limits);
  for (;;) {
    const r = steps.next();
    if (r.done === true) return r.value;
  }
}

/** シートの行数。結合セルがデータより下まで伸びていれば、そこまで含める（描画で結合を切らない）。 */
export function rowCountOf(data: SheetData | null): number {
  if (data === null) return 0;
  let max = data.maxRow;
  for (let i = 2; i < data.merges.length; i += 4) max = Math.max(max, data.merges[i] ?? -1);
  return max + 1;
}

function keysOf(data: SheetData | null, sst: readonly string[]): Float64Array {
  const n = rowCountOf(data);
  const keys = new Float64Array(n);
  if (data === null) return keys;
  for (let r = 0; r < n; r += 1) keys[r] = rowKey(data.rows[r], sst);
  return keys;
}

function compareSheet(
  index: number,
  oldSheet: SheetInfo | null,
  sstOld: readonly string[],
  newSheet: SheetInfo | null,
  sstNew: readonly string[],
  limits: ExcelLimits,
): SheetComparison {
  const oldData = oldSheet?.data ?? null;
  const newData = newSheet?.data ?? null;
  const alignment = alignRows(keysOf(oldData, sstOld), keysOf(newData, sstNew), limits, (o, n) =>
    rowSimilarity(oldData?.rows[o]?.cells, sstOld, newData?.rows[n]?.cells, sstNew),
  );
  const { oldRow, newRow } = alignment;
  const rowState = new Uint8Array(oldRow.length);
  const changed: number[] = [];
  let changedCells = 0;
  let addedRows = 0;
  let removedRows = 0;
  let changedRowCount = 0;

  for (let i = 0; i < oldRow.length; i += 1) {
    const o = oldRow[i] ?? -1;
    const n = newRow[i] ?? -1;
    const cellsOld = o >= 0 ? oldData?.rows[o]?.cells : undefined;
    const cellsNew = n >= 0 ? newData?.rows[n]?.cells : undefined;
    let state = ROW_SAME;
    if (o < 0) {
      state = ROW_ADDED;
      addedRows += 1;
      changedCells += changedColumns(undefined, sstOld, cellsNew, sstNew).length;
    } else if (n < 0) {
      state = ROW_REMOVED;
      removedRows += 1;
      changedCells += changedColumns(cellsOld, sstOld, undefined, sstNew).length;
    } else {
      const cols = changedColumns(cellsOld, sstOld, cellsNew, sstNew);
      if (cols.length > 0) {
        state = ROW_CHANGED;
        changedRowCount += 1;
        changedCells += cols.length;
      }
    }
    rowState[i] = state;
    if (state !== ROW_SAME) changed.push(i);
  }

  let mark: SheetMark;
  if (oldSheet === null) mark = 'added';
  else if (newSheet === null) mark = 'removed';
  else mark = changed.length > 0 || oldSheet.kind !== newSheet.kind || oldSheet.state !== newSheet.state ? 'changed' : 'same';

  const maxCol = Math.max(oldData?.maxCol ?? -1, newData?.maxCol ?? -1, maxMergeCol(oldData), maxMergeCol(newData));

  return {
    index,
    old: oldSheet,
    new: newSheet,
    mark,
    renamed: oldSheet !== null && newSheet !== null && oldSheet.name !== newSheet.name,
    positional: alignment.positional,
    oldRow,
    newRow,
    rowState,
    changedRows: Int32Array.from(changed),
    changedCells,
    addedRows,
    removedRows,
    changedRowCount,
    colCount: Math.min(limits.maxColumns, maxCol + 1),
  };
}

function maxMergeCol(data: SheetData | null): number {
  if (data === null) return -1;
  let max = -1;
  for (let i = 3; i < data.merges.length; i += 4) max = Math.max(max, data.merges[i] ?? -1);
  return max;
}
