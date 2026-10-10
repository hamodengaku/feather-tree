/*
 * Excel 差分モードの範囲の選択（docs/07 7.1）。左右のグリッドで共有する。ExcelState が 1 つ持つ。
 *
 * Excel と同じく、押してドラッグで範囲、Shift で起点から広げ直し、Ctrl で範囲を足す。
 * 行番号・列番号を押せば行・列全体（ドラッグしても行・列全体のまま伸ばす）。
 */

import { rangeOf, type CellRange } from './excelConflict.js';

export type PointerKind = 'cell' | 'row' | 'col';

export interface Pos {
  readonly row: number;
  readonly col: number;
}

/** シートの大きさ（揃えた行・列の数）。 */
export interface GridSize {
  readonly rows: number;
  readonly cols: number;
}

export class RangeSelection {
  ranges = $state<readonly CellRange[]>([]);
  /** Shift で範囲を広げるときの起点。 */
  #anchor: Pos | null = null;
  /** ドラッグ中なら、押し始めた所の種類。 */
  #drag: PointerKind | null = null;

  /** 押した。返すのは「今のセル」（Shift なら起点のまま）。 */
  down(kind: PointerKind, row: number, col: number, mods: { shift: boolean; ctrl: boolean }, size: GridSize): Pos {
    const at = clampPos(kind, row, col, size);
    const anchor = mods.shift && this.#anchor !== null ? this.#anchor : at;
    const range = rectFor(kind, anchor, at, size);
    if (mods.shift && this.ranges.length > 0) this.ranges = [...this.ranges.slice(0, -1), range];
    else if (mods.ctrl) this.ranges = [...this.ranges, range];
    else this.ranges = [range];
    if (!mods.shift) this.#anchor = at;
    this.#drag = kind;
    return mods.shift ? anchor : at;
  }

  /** 押したまま別の所に入った。直前の範囲を起点からそこまでに伸ばす。 */
  enter(kind: PointerKind, row: number, col: number, size: GridSize): void {
    const drag = this.#drag;
    const anchor = this.#anchor;
    if (drag === null || anchor === null || this.ranges.length === 0) return;
    // 行番号で始めたドラッグは行全体、列番号なら列全体のまま伸ばす
    const at = clampPos(drag === 'cell' ? kind : drag, row, col, size);
    this.ranges = [...this.ranges.slice(0, -1), rectFor(drag, anchor, at, size)];
  }

  up(): void {
    this.#drag = null;
  }

  /** 範囲をこのセル 1 つにする（マウス以外からの選択）。 */
  single(row: number, col: number): void {
    this.ranges = [rangeOf({ row, col }, { row, col })];
    this.#anchor = { row, col };
  }

  clear(): void {
    this.ranges = [];
    this.#anchor = null;
    this.#drag = null;
  }

  /** 範囲が 1 セルだけならそのセル。 */
  get singleCell(): Pos | null {
    const range = this.ranges.length === 1 ? this.ranges[0] : undefined;
    if (range === undefined || range.r1 !== range.r2 || range.c1 !== range.c2) return null;
    return { row: range.r1, col: range.c1 };
  }
}

function clampPos(kind: PointerKind, row: number, col: number, size: GridSize): Pos {
  const maxRow = Math.max(0, size.rows - 1);
  const maxCol = Math.max(0, size.cols - 1);
  return {
    row: kind === 'col' ? 0 : Math.min(maxRow, Math.max(0, row)),
    col: kind === 'row' ? 0 : Math.min(maxCol, Math.max(0, col)),
  };
}

function rectFor(kind: PointerKind, a: Pos, b: Pos, size: GridSize): CellRange {
  const lastRow = Math.max(0, size.rows - 1);
  const lastCol = Math.max(0, size.cols - 1);
  if (kind === 'row') return { r1: Math.min(a.row, b.row), c1: 0, r2: Math.max(a.row, b.row), c2: lastCol };
  if (kind === 'col') return { r1: 0, c1: Math.min(a.col, b.col), r2: lastRow, c2: Math.max(a.col, b.col) };
  return rangeOf(a, b);
}
