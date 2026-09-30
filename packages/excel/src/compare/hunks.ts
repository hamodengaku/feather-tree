/*
 * 差分モードの「行単位の比較」（決定 33 / 要件 E5）。
 *
 * 行を 1 レコードとみなし、揃えた行のうち状態が same でないものを、前後の文脈行と一緒に
 * hunk にまとめる（unified diff と同じ規則: 文脈行で膨らませ、間が 2×文脈以下なら 1 つにつなぐ）。
 *
 * 列は hunk ごとに「その hunk の行で、どちらかの側に値がある列」の和集合。多すぎれば、
 * 値が変わった列を優先して上限まで残す。行の合計が上限に達したら打ち切って `truncated` を立てる。
 */

import { DEFAULT_LIMITS, type ExcelLimits } from '../limits.js';
import type { CellData } from '../model/types.js';
import { cellAt, changedColumns, clipText, formatContextOf, formattedText, isEmptyCell } from './cells.js';
import { ROW_ADDED, ROW_CHANGED, ROW_REMOVED, type SheetComparison, type SheetMark, type WorkbookComparison } from './compare.js';

export type RowDiffKind = 'same' | 'changed' | 'added' | 'removed';

export interface RowDiffRow {
  readonly kind: RowDiffKind;
  /** その側のシートの行番号（0 始まり）。無い側は -1。 */
  readonly oldRow: number;
  readonly newRow: number;
  /** hunk の列ごとの表示文字。無い側は null。 */
  readonly old: string[] | null;
  readonly new: string[] | null;
  /** 値が違う列（hunk の列の添字）。 */
  readonly changed: number[];
}

export interface RowDiffHunk {
  /** 0 始まりの列番号。 */
  readonly columns: number[];
  readonly rows: RowDiffRow[];
}

export interface RowDiffSheet {
  readonly index: number;
  readonly oldName: string | null;
  readonly newName: string | null;
  readonly mark: SheetMark;
  readonly renamed: boolean;
  readonly positional: boolean;
  readonly hunks: RowDiffHunk[];
}

export interface RowDiff {
  readonly sheets: RowDiffSheet[];
  readonly truncated: boolean;
  readonly vbaChanged: boolean | null;
}

export function buildRowDiff(
  comparison: WorkbookComparison,
  contextLines: number,
  limits: ExcelLimits = DEFAULT_LIMITS,
): RowDiff {
  const sheets: RowDiffSheet[] = [];
  let budget = limits.maxRowDiffLines;
  let truncated = false;
  const context = Math.max(0, Math.trunc(contextLines));

  for (const sheet of comparison.sheets) {
    if (sheet.mark === 'same' && !sheet.renamed) continue;
    const hunks: RowDiffHunk[] = [];
    for (const [start, end] of hunkRanges(sheet, context)) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const take = Math.min(end, start + budget);
      if (take < end) truncated = true;
      hunks.push(buildHunk(comparison, sheet, start, take, limits.maxRowDiffColumns));
      budget -= take - start;
    }
    sheets.push({
      index: sheet.index,
      oldName: sheet.old?.name ?? null,
      newName: sheet.new?.name ?? null,
      mark: sheet.mark,
      renamed: sheet.renamed,
      positional: sheet.positional,
      hunks,
    });
  }
  // 予算を使い切った後に、まだ出していない変更のあるシートが残っていれば打ち切り
  // （行の途中で切れた場合は上のループで既に立っている）
  return { sheets, truncated, vbaChanged: comparison.vbaChanged };
}

/** 揃えた行の [start, end) の並び。 */
function hunkRanges(sheet: SheetComparison, context: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const total = sheet.oldRow.length;
  for (let k = 0; k < sheet.changedRows.length; k += 1) {
    const i = sheet.changedRows[k] ?? 0;
    const start = Math.max(0, i - context);
    const end = Math.min(total, i + 1 + context);
    const last = out[out.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

function buildHunk(
  comparison: WorkbookComparison,
  sheet: SheetComparison,
  start: number,
  end: number,
  maxColumns: number,
): RowDiffHunk {
  const sstOld = comparison.old?.sst ?? [];
  const sstNew = comparison.new?.sst ?? [];
  const ctxOld = formatContextOf(comparison.old);
  const ctxNew = formatContextOf(comparison.new);
  const oldData = sheet.old?.data ?? null;
  const newData = sheet.new?.data ?? null;

  const cellsOf = (i: number): [readonly CellData[] | undefined, readonly CellData[] | undefined] => {
    const o = sheet.oldRow[i] ?? -1;
    const n = sheet.newRow[i] ?? -1;
    return [o >= 0 ? oldData?.rows[o]?.cells : undefined, n >= 0 ? newData?.rows[n]?.cells : undefined];
  };

  // 列の和集合と、値が変わった列
  const present = new Set<number>();
  const changedSet = new Set<number>();
  const changedByRow: number[][] = [];
  for (let i = start; i < end; i += 1) {
    const [a, b] = cellsOf(i);
    for (const c of a ?? []) if (!isEmptyCell(c)) present.add(c.col);
    for (const c of b ?? []) if (!isEmptyCell(c)) present.add(c.col);
    const cols = changedColumns(a, sstOld, b, sstNew);
    changedByRow.push(cols);
    for (const c of cols) changedSet.add(c);
  }
  let columns = [...present].sort((x, y) => x - y);
  if (columns.length > maxColumns) {
    const keep = new Set<number>([...changedSet].sort((x, y) => x - y).slice(0, maxColumns));
    for (const c of columns) {
      if (keep.size >= maxColumns) break;
      keep.add(c);
    }
    columns = [...keep].sort((x, y) => x - y);
  }
  const indexOf = new Map<number, number>(columns.map((c, i) => [c, i]));

  const rows: RowDiffRow[] = [];
  for (let i = start; i < end; i += 1) {
    const [a, b] = cellsOf(i);
    const o = sheet.oldRow[i] ?? -1;
    const n = sheet.newRow[i] ?? -1;
    const state = sheet.rowState[i];
    const kind: RowDiffKind =
      state === ROW_CHANGED ? 'changed' : state === ROW_ADDED ? 'added' : state === ROW_REMOVED ? 'removed' : 'same';
    const changed: number[] = [];
    for (const c of changedByRow[i - start] ?? []) {
      const idx = indexOf.get(c);
      if (idx !== undefined) changed.push(idx);
    }
    rows.push({
      kind,
      oldRow: o,
      newRow: n,
      old: o >= 0 ? columns.map((c) => clipText(formattedText(cellAt(a, c), ctxOld))) : null,
      new: n >= 0 ? columns.map((c) => clipText(formattedText(cellAt(b, c), ctxNew))) : null,
      changed,
    });
  }
  return { columns, rows };
}
