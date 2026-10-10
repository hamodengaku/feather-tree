/*
 * Excel のコンフリクトの採用（excelResolveConflict）の入力検証（決定 34）。**純関数だけ**（git も session も使わない）。
 *
 * renderer から来た値はそのまま添字に使わない。座標は整数で範囲内、側は 2 種のどちらか、並びは 2 種のどちらかだけを通す。
 * 数は「シートのセル数」などを上限にする（巨大な配列で main を止めさせない）。
 * パス・未マージであること・トークンの照合は service.ts の guardExcelResolve が持つ。
 */

import { EXCEL_LIMITS, type ExcelCellChoices, type ExcelResolveRequest, type SheetComparison } from '@feathertree/core';
import type { ExcelBothOrderDto, ExcelCellChoicesDto, ExcelConflictSideDto } from '@feathertree/ipc';
import { HandlerError } from '../errors.js';

/** 打った値の長さの上限（Excel の 1 セルの上限）。docs/07 7.1。 */
export const MAX_EDIT_LENGTH = 32767;

const NUL = String.fromCharCode(0);

export function validSide(side: unknown): ExcelConflictSideDto {
  if (side === 'ours' || side === 'theirs') return side;
  throw new HandlerError({ kind: 'internal', message: '採用する側の指定が不正です。' });
}

/** 採用の指定（ファイル単位 / セル単位）を検証して core の形にする。 */
export function validResolution(resolution: unknown, sheets: readonly SheetComparison[]): ExcelResolveRequest {
  const r = resolution as { kind?: unknown; side?: unknown; choices?: unknown } | null | undefined;
  if (r?.kind === 'file') return { kind: 'file', side: validSide(r.side) };
  if (r?.kind !== 'cells') throw new HandlerError({ kind: 'internal', message: '採用の指定が不正です。' });
  return { kind: 'cells', choices: validChoices(r.choices as ExcelCellChoicesDto, sheets) };
}

function validChoices(choices: ExcelCellChoicesDto, sheets: readonly SheetComparison[]): ExcelCellChoices {
  const bad = (): never => {
    throw new HandlerError({ kind: 'internal', message: '採用するセルの指定が不正です。' });
  };
  const inRange = (n: unknown, max: number): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < max;
  if (choices === null || typeof choices !== 'object') return bad();
  const { cells, rows, cols, rest } = choices;
  const edits = choices.edits ?? [];
  const hunks = choices.hunks ?? [];
  if (!Array.isArray(cells) || !Array.isArray(rows) || !Array.isArray(cols) || !Array.isArray(edits) || !Array.isArray(hunks)) {
    return bad();
  }
  const rowLimit = EXCEL_LIMITS.maxRowsPerSheet * sheets.length;
  if (
    cells.length > EXCEL_LIMITS.maxCellsPerBook ||
    edits.length > EXCEL_LIMITS.maxCellsPerBook ||
    rows.length > rowLimit ||
    hunks.length > rowLimit ||
    cols.length > EXCEL_LIMITS.maxColumns * sheets.length
  ) {
    return bad();
  }
  const validOrder = (o: unknown): ExcelBothOrderDto => (o === 'ours-theirs' || o === 'theirs-ours' ? o : bad());
  const sheetOf = (n: unknown): SheetComparison => (inRange(n, sheets.length) ? (sheets[n] as SheetComparison) : bad());
  const rowIn = (s: SheetComparison, r: unknown): number => (inRange(r, s.oldRow.length) ? r : bad());
  const colIn = (s: SheetComparison, c: unknown): number => (inRange(c, s.colCount) ? c : bad());
  return {
    cells: cells.map((c) => {
      const s = sheetOf(c?.sheet);
      return { sheet: c.sheet, row: rowIn(s, c.row), col: colIn(s, c.col), side: validSide(c.side) };
    }),
    rows: rows.map((r) => ({ sheet: r?.sheet, row: rowIn(sheetOf(r?.sheet), r.row), side: validSide(r.side) })),
    cols: cols.map((c) => ({ sheet: c?.sheet, col: colIn(sheetOf(c?.sheet), c.col), side: validSide(c.side) })),
    rest: rest === null ? null : validSide(rest),
    edits: edits.map((e) => {
      const s = sheetOf(e?.sheet);
      // Excel の 1 セルの上限（32,767 文字）。NUL は XML に書けない
      if (typeof e.value !== 'string' || e.value.length > MAX_EDIT_LENGTH || e.value.includes(NUL)) return bad();
      return { sheet: e.sheet, row: rowIn(s, e.row), col: colIn(s, e.col), value: e.value };
    }),
    hunks: hunks.map((h) => {
      const s = sheetOf(h?.sheet);
      const row = rowIn(s, h.row);
      const end = Number.isInteger(h.end) && h.end > row && h.end <= s.oldRow.length ? h.end : bad();
      return { sheet: h.sheet, row, end, order: validOrder(h.order) };
    }),
  };
}
