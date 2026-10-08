/*
 * Excel 差分モードのコンフリクト（決定 34）の採り方。**純関数だけ。**
 *
 * 採り方は「セル > 行 > 列 > 残りすべて」の順に効く（main の planCsvResolution と同じ）。
 * 片側にしか無い行（追加・削除）は「行 > 残りすべて」だけで決まる——その行を入れるか入れないかの話で、
 * 列やセルの指定とは噛み合わないため。
 *
 * ここで数える「未決定」は画面の案内のため。書き込んでよいかの判定は main が読み直したものでやり直す。
 */

import type { ExcelCellChoicesDto, ExcelConflictSideDto, ExcelSheetLayoutDto } from '@feathertree/ipc';
import { ROW_ADDED, ROW_REMOVED } from './excelGrid.js';

export type ConflictSide = ExcelConflictSideDto;

export interface ConflictChoiceState {
  /** キーは `揃えた行:列`。 */
  readonly cells: ReadonlyMap<string, ConflictSide>;
  readonly rows: ReadonlyMap<number, ConflictSide>;
  readonly cols: ReadonlyMap<number, ConflictSide>;
  readonly rest: ConflictSide | null;
}

export function cellKey(row: number, col: number): string {
  return String(row) + ':' + String(col);
}

/** 片側にしか無い行（追加・削除）か。 */
export function isOneSidedRow(layout: ExcelSheetLayoutDto, row: number): boolean {
  const state = layout.rowState[row] ?? 0;
  return state === ROW_ADDED || state === ROW_REMOVED;
}

/** 両側にある行のセルの採り方。決まっていなければ null。 */
export function choiceForCell(state: ConflictChoiceState, row: number, col: number): ConflictSide | null {
  return state.cells.get(cellKey(row, col)) ?? state.rows.get(row) ?? state.cols.get(col) ?? state.rest;
}

/** 片側にしか無い行の採り方。決まっていなければ null。 */
export function choiceForRow(state: ConflictChoiceState, row: number): ConflictSide | null {
  return state.rows.get(row) ?? state.rest;
}

/** 揃えた座標の採り方（グリッドの印に使う）。片側にしか無い行は行の採り方。 */
export function choiceAt(
  layout: ExcelSheetLayoutDto,
  state: ConflictChoiceState,
  row: number,
  col: number,
): ConflictSide | null {
  return isOneSidedRow(layout, row) ? choiceForRow(state, row) : choiceForCell(state, row, col);
}

/** 決めるべき所（セル、または片側にしか無い行）を並び順に列挙する。col = -1 は行全体。 */
export function* conflictTargets(layout: ExcelSheetLayoutDto): Generator<{ row: number; col: number }> {
  const cells = layout.conflictCells ?? [];
  let k = 0;
  for (const row of layout.changedRows) {
    if (isOneSidedRow(layout, row)) {
      yield { row, col: -1 };
      continue;
    }
    // conflictCells は揃えた行の昇順に並んでいる（main が changedRows の順に作る）
    while (k + 1 < cells.length && (cells[k] ?? 0) < row) k += 2;
    while (k + 1 < cells.length && cells[k] === row) {
      yield { row, col: cells[k + 1] ?? 0 };
      k += 2;
    }
  }
}

function decided(state: ConflictChoiceState, t: { row: number; col: number }): boolean {
  return (t.col < 0 ? choiceForRow(state, t.row) : choiceForCell(state, t.row, t.col)) !== null;
}

/** 未決定の数。セル単位で採れない（conflictCells が無い）なら null。 */
export function unresolvedCount(layout: ExcelSheetLayoutDto, state: ConflictChoiceState): number | null {
  if (layout.conflictCells == null) return null;
  let n = 0;
  for (const t of conflictTargets(layout)) if (!decided(state, t)) n += 1;
  return n;
}

/**
 * 今の位置より後ろで最初の未決定（無ければ先頭から探し直す）。全部決まっていれば null。
 * 片側にしか無い行は列 0 を返す（行全体の指定なので列はどこでもよい）。
 */
export function nextUnresolved(
  layout: ExcelSheetLayoutDto,
  state: ConflictChoiceState,
  from: { row: number; col: number } | null,
): { row: number; col: number } | null {
  let first: { row: number; col: number } | null = null;
  for (const t of conflictTargets(layout)) {
    if (decided(state, t)) continue;
    const at = { row: t.row, col: Math.max(0, t.col) };
    first ??= at;
    if (from === null || t.row > from.row || (t.row === from.row && t.col > from.col)) return at;
  }
  return first;
}

export function toChoicesDto(state: ConflictChoiceState): ExcelCellChoicesDto {
  return {
    cells: [...state.cells].map(([key, side]) => {
      const [row, col] = key.split(':').map(Number);
      return { row: row ?? 0, col: col ?? 0, side };
    }),
    rows: [...state.rows].map(([row, side]) => ({ row, side })),
    cols: [...state.cols].map(([col, side]) => ({ col, side })),
    rest: state.rest,
  };
}
