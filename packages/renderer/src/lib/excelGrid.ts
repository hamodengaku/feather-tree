/*
 * Excel グリッド（決定 33）の純関数。**描画もスクロールも持たない。**
 *
 * 新旧のグリッドは同じ幾何（main から来る ExcelSheetLayoutDto）を共有するので、
 * 行の高さ・列の幅はここで 1 回だけ求め、左右の両方がそれを使う。
 */

import type { ExcelRowSideDto, ExcelSheetLayoutDto } from '@feathertree/ipc';

export const ROW_SAME = 0;
export const ROW_CHANGED = 1;
export const ROW_ADDED = 2;
export const ROW_REMOVED = 3;

export const HIDDEN_OLD = 1;
export const HIDDEN_NEW = 2;

/** 行ページの大きさ（main の EXCEL_ROW_PAGE_LIMIT と同じ）。 */
export const ROW_PAGE = 256;

/** 列見出しの高さ（px）。 */
export const HEADER_HEIGHT = 20;

/** その揃えた行に「在る」側の非表示の印（無い側の印は数えない）。 */
function presentHiddenBits(layout: ExcelSheetLayoutDto, i: number): { present: number; hidden: number } {
  let present = 0;
  if ((layout.oldRow[i] ?? -1) >= 0) present |= HIDDEN_OLD;
  if ((layout.newRow[i] ?? -1) >= 0) present |= HIDDEN_NEW;
  return { present, hidden: (layout.rowHidden[i] ?? 0) & present };
}

/**
 * 行を隠すか。在る側すべてで非表示で、しかも変わっていない行だけを隠す。
 * **変更を含む非表示の行は常に出す**（隠すと、変わったことに気づけない）。
 */
export function rowCollapsed(layout: ExcelSheetLayoutDto, i: number, showHidden: boolean): boolean {
  if (showHidden) return false;
  const { present, hidden } = presentHiddenBits(layout, i);
  return present !== 0 && hidden === present && (layout.rowState[i] ?? ROW_SAME) === ROW_SAME;
}

/** どちらかの側で非表示の行か（行見出しに印を出す）。 */
export function rowHiddenSomewhere(layout: ExcelSheetLayoutDto, i: number): boolean {
  return presentHiddenBits(layout, i).hidden !== 0;
}

export function effectiveRowHeights(layout: ExcelSheetLayoutDto, showHidden: boolean): Float64Array {
  const out = new Float64Array(layout.rowCount);
  for (let i = 0; i < layout.rowCount; i += 1) {
    out[i] = rowCollapsed(layout, i, showHidden) ? 0 : Math.max(1, layout.rowHeight[i] ?? 20);
  }
  return out;
}

/** 列を隠すか。両側で非表示の列だけを隠す（片側だけなら出して印を付ける）。 */
export function columnCollapsed(layout: ExcelSheetLayoutDto, c: number, showHidden: boolean): boolean {
  return !showHidden && (layout.colHidden[c] ?? 0) === (HIDDEN_OLD | HIDDEN_NEW);
}

export function effectiveColWidths(layout: ExcelSheetLayoutDto, showHidden: boolean): Float64Array {
  const out = new Float64Array(layout.colCount);
  for (let c = 0; c < layout.colCount; c += 1) {
    out[c] = columnCollapsed(layout, c, showHidden) ? 0 : Math.max(1, layout.colWidth[c] ?? 64);
  }
  return out;
}

export interface ScrollPosition {
  readonly top: number;
  readonly left: number;
}

/**
 * スクロール同期（決定 33）。相手へ写す値を返す。**同じ値なら null**（代入しない）。
 *
 * 同じ値を代入しても scroll イベントは出ないが、画素の端数で食い違うと往復で揺れるので、
 * 0.5px 未満の差は同じとみなす。
 */
export function mirrorScroll(
  from: ScrollPosition,
  to: ScrollPosition,
): { readonly top: number | null; readonly left: number | null } {
  return {
    top: Math.abs(from.top - to.top) < 0.5 ? null : from.top,
    left: Math.abs(from.left - to.left) < 0.5 ? null : from.left,
  };
}

/** 行の片側の中で、列 col のセルの添字（無ければ -1）。cols は昇順。 */
export function cellIndex(side: ExcelRowSideDto | null | undefined, col: number): number {
  if (side == null) return -1;
  let lo = 0;
  let hi = side.cols.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = side.cols[mid] ?? -1;
    if (c === col) return mid;
    if (c < col) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export interface MergeRect {
  readonly r1: number;
  readonly c1: number;
  readonly r2: number;
  readonly c2: number;
}

export function mergeRects(flat: readonly number[]): MergeRect[] {
  const out: MergeRect[] = [];
  for (let i = 0; i + 3 < flat.length; i += 4) {
    out.push({ r1: flat[i] ?? 0, c1: flat[i + 1] ?? 0, r2: flat[i + 2] ?? 0, c2: flat[i + 3] ?? 0 });
  }
  return out;
}

/** 見えている範囲 [rowStart, rowEnd) × [colStart, colEnd) と交わる結合。 */
export function visibleMerges(
  rects: readonly MergeRect[],
  rowStart: number,
  rowEnd: number,
  colStart: number,
  colEnd: number,
): MergeRect[] {
  return rects.filter((m) => m.r1 < rowEnd && m.r2 >= rowStart && m.c1 < colEnd && m.c2 >= colStart);
}

/** 結合に覆われて、単独では描かないセルの鍵（左上のセルは描く側なので含めない）。 */
export function coveredCells(rects: readonly MergeRect[]): Set<string> {
  const out = new Set<string>();
  for (const m of rects) {
    for (let r = m.r1; r <= m.r2; r += 1) {
      for (let c = m.c1; c <= m.c2; c += 1) {
        if (r !== m.r1 || c !== m.c1) out.add(String(r) + ':' + String(c));
      }
    }
  }
  return out;
}

/** 0 始まりの列番号 → A, B, …, AA。 */
export function columnLabel(col: number): string {
  let n = col + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** 行見出しの幅（px）。両側の行番号の最大の桁数で決める（左右で同じ幅にする）。 */
export function rowHeaderWidth(layout: ExcelSheetLayoutDto | null): number {
  if (layout === null) return 40;
  let max = 0;
  for (let i = 0; i < layout.rowCount; i += 1) {
    max = Math.max(max, layout.oldRow[i] ?? -1, layout.newRow[i] ?? -1);
  }
  const digits = String(max + 1).length;
  return Math.max(32, digits * 8 + 16);
}

/**
 * 次（前）の変更の行。`current` より後（前）で最初のもの。無ければ端で折り返す。
 * 変更が 1 つも無ければ null。
 */
export function nextChangedRow(changedRows: readonly number[], current: number | null, direction: 1 | -1): number | null {
  if (changedRows.length === 0) return null;
  if (current === null) return direction === 1 ? (changedRows[0] ?? null) : (changedRows[changedRows.length - 1] ?? null);
  if (direction === 1) {
    for (const r of changedRows) if (r > current) return r;
    return changedRows[0] ?? null;
  }
  for (let i = changedRows.length - 1; i >= 0; i -= 1) {
    const r = changedRows[i] ?? -1;
    if (r < current) return r;
  }
  return changedRows[changedRows.length - 1] ?? null;
}

/** 行 [start, end) を覆うページの番号。 */
export function pagesFor(start: number, end: number): number[] {
  const out: number[] = [];
  if (end <= start) return out;
  for (let p = Math.floor(start / ROW_PAGE); p <= Math.floor((end - 1) / ROW_PAGE); p += 1) out.push(p);
  return out;
}
