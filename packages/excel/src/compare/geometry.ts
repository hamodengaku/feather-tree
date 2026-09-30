/*
 * 揃えた行・列の幾何（決定 33 / EA-3）。
 *
 * **新旧の幾何を同一にする。** 行の高さは対になった 2 行の大きいほう（片側しか無ければその側）、
 * 列の幅は列ごとの大きいほう。こうすると左右のグリッドが同じ大きさになり、スクロールの同期は
 * 画素の値を相手へ写すだけで済む。
 *
 * 非表示の行・列は**高さ・幅を消さずに印だけ付けて返す**（bit0 = 旧側で非表示、bit1 = 新側で非表示）。
 * 隠すかどうか（変更を含む非表示行は出す、など）は renderer が決める。
 */

import type { SheetData } from '../model/types.js';
import { columnSpecAt, rowHeightPx } from '../sheet/worksheet.js';
import type { SheetComparison } from './compare.js';

export const HIDDEN_OLD = 1;
export const HIDDEN_NEW = 2;

export interface SheetGeometry {
  readonly rowCount: number;
  readonly oldRow: Int32Array;
  readonly newRow: Int32Array;
  readonly rowState: Uint8Array;
  readonly rowHeightPx: Float32Array;
  readonly rowHidden: Uint8Array;
  readonly colCount: number;
  readonly colWidthPx: Float32Array;
  readonly colHidden: Uint8Array;
  /** 結合セル（揃えた座標）。r1, c1, r2, c2 の 4 つ組。 */
  readonly oldMerges: Int32Array;
  readonly newMerges: Int32Array;
  readonly changedRows: Int32Array;
  /** 窓枠の固定（新側を優先）。無ければ null。 */
  readonly frozen: { readonly rows: number; readonly cols: number } | null;
  /** 揃えた行ごとの、その側の行の書式（cellXfs の添字。無ければ -1）。 */
  readonly oldRowStyle: Int32Array;
  readonly newRowStyle: Int32Array;
  /** 列ごとの、その側の列の書式（無ければ -1）。 */
  readonly oldColStyle: Int32Array;
  readonly newColStyle: Int32Array;
}

export function buildGeometry(sheet: SheetComparison): SheetGeometry {
  const oldData = sheet.old?.data ?? null;
  const newData = sheet.new?.data ?? null;
  const rowCount = sheet.oldRow.length;
  const rowHeight = new Float32Array(rowCount);
  const rowHidden = new Uint8Array(rowCount);

  for (let i = 0; i < rowCount; i += 1) {
    const o = sheet.oldRow[i] ?? -1;
    const n = sheet.newRow[i] ?? -1;
    let h = 0;
    let hidden = 0;
    if (o >= 0 && oldData !== null) {
      h = Math.max(h, rowPx(oldData, o));
      if (oldData.rows[o]?.hidden === true) hidden |= HIDDEN_OLD;
    }
    if (n >= 0 && newData !== null) {
      h = Math.max(h, rowPx(newData, n));
      if (newData.rows[n]?.hidden === true) hidden |= HIDDEN_NEW;
    }
    rowHeight[i] = h > 0 ? h : rowHeightPx(15);
    rowHidden[i] = hidden;
  }

  const colCount = sheet.colCount;
  const colWidth = new Float32Array(colCount);
  const colHidden = new Uint8Array(colCount);
  for (let c = 0; c < colCount; c += 1) {
    let w = 0;
    let hidden = 0;
    if (oldData !== null) {
      w = Math.max(w, colPx(oldData, c));
      if (columnSpecAt(oldData.cols, c)?.hidden === true) hidden |= HIDDEN_OLD;
    }
    if (newData !== null) {
      w = Math.max(w, colPx(newData, c));
      if (columnSpecAt(newData.cols, c)?.hidden === true) hidden |= HIDDEN_NEW;
    }
    colWidth[c] = w > 0 ? w : 64;
    colHidden[c] = hidden;
  }

  const rowStyle = (data: SheetData | null, sideRow: Int32Array): Int32Array => {
    const out = new Int32Array(rowCount).fill(-1);
    if (data === null) return out;
    for (let i = 0; i < rowCount; i += 1) {
      const r = sideRow[i] ?? -1;
      if (r >= 0) out[i] = data.rows[r]?.style ?? -1;
    }
    return out;
  };
  const colStyle = (data: SheetData | null): Int32Array => {
    const out = new Int32Array(colCount).fill(-1);
    if (data === null) return out;
    for (let c = 0; c < colCount; c += 1) out[c] = columnSpecAt(data.cols, c)?.style ?? -1;
    return out;
  };

  return {
    rowCount,
    oldRow: sheet.oldRow,
    newRow: sheet.newRow,
    rowState: sheet.rowState,
    rowHeightPx: rowHeight,
    rowHidden,
    colCount,
    colWidthPx: colWidth,
    colHidden,
    oldMerges: mapMerges(oldData, sheet.oldRow, colCount),
    newMerges: mapMerges(newData, sheet.newRow, colCount),
    changedRows: sheet.changedRows,
    frozen: newData?.frozen ?? oldData?.frozen ?? null,
    oldRowStyle: rowStyle(oldData, sheet.oldRow),
    newRowStyle: rowStyle(newData, sheet.newRow),
    oldColStyle: colStyle(oldData),
    newColStyle: colStyle(newData),
  };
}

function rowPx(data: SheetData, row: number): number {
  const pt = data.rows[row]?.heightPt;
  return rowHeightPx(pt !== undefined && Number.isFinite(pt) ? pt : data.defaultRowHeightPt);
}

function colPx(data: SheetData, col: number): number {
  const spec = columnSpecAt(data.cols, col);
  if (spec !== undefined && Number.isFinite(spec.widthPx)) return spec.widthPx;
  return data.defaultColWidthPx;
}

/** シートの行番号 → 揃えた添字、の写しを作り、結合の範囲を揃えた座標に直す。 */
function mapMerges(data: SheetData | null, sideRow: Int32Array, colCount: number): Int32Array {
  if (data === null || data.merges.length === 0) return new Int32Array(0);
  let maxRow = -1;
  for (let i = 0; i < sideRow.length; i += 1) maxRow = Math.max(maxRow, sideRow[i] ?? -1);
  const toAligned = new Int32Array(maxRow + 1).fill(-1);
  for (let i = 0; i < sideRow.length; i += 1) {
    const r = sideRow[i] ?? -1;
    if (r >= 0) toAligned[r] = i;
  }
  const out: number[] = [];
  for (let i = 0; i + 3 < data.merges.length; i += 4) {
    const r1 = toAligned[data.merges[i] ?? -1] ?? -1;
    const r2 = toAligned[data.merges[i + 2] ?? -1] ?? -1;
    if (r1 < 0 || r2 < 0) continue;
    // 列は読んでいる範囲（colCount）に収める。A1:XFD1 のような結合で列数を超えた矩形を渡さない
    const c1 = Math.min(colCount - 1, Math.max(0, data.merges[i + 1] ?? 0));
    const c2 = Math.min(colCount - 1, Math.max(c1, data.merges[i + 3] ?? 0));
    if (colCount <= 0) continue;
    out.push(r1, c1, r2, c2);
  }
  return Int32Array.from(out);
}

