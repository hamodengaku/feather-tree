/*
 * Excel 差分モードのコンフリクト（決定 34）の採り方。**純関数だけ。**
 *
 * 採り方は「セル > 行 > 列 > 残りすべて」の順に効く（main の planCsvResolution / planXlsxResolution と同じ）。
 * 片側にしか無い行（追加・削除）は「行 > 残りすべて」だけで決まる——その行を入れるか入れないかの話で、
 * 列やセルの指定とは噛み合わないため。指定はシートごと（ブックでは複数のシートをまたいで決める）。
 *
 * 決めるべき所と相手側を採れない所は、main がシートの概要（ExcelSheetSummaryDto.conflict）に載せてくる。
 * ここで数える「未決定」「採れない所に相手側」は画面の案内のため。書き込んでよいかは main がやり直す。
 */

import type { ExcelBlockReasonDto, ExcelCellChoicesDto, ExcelConflictSideDto, ExcelSheetSummaryDto } from '@feathertree/ipc';

export type ConflictSide = ExcelConflictSideDto;

export interface ConflictChoiceState {
  /** キーは `シート:揃えた行:列`。 */
  readonly cells: ReadonlyMap<string, ConflictSide>;
  /** キーは `シート:揃えた行`。 */
  readonly rows: ReadonlyMap<string, ConflictSide>;
  /** キーは `シート:列`。 */
  readonly cols: ReadonlyMap<string, ConflictSide>;
  readonly rest: ConflictSide | null;
}

export interface ConflictPos {
  readonly sheet: number;
  readonly row: number;
  readonly col: number;
}

export function cellKey(sheet: number, row: number, col: number): string {
  return `${String(sheet)}:${String(row)}:${String(col)}`;
}

export function lineKey(sheet: number, index: number): string {
  return `${String(sheet)}:${String(index)}`;
}

/** 片側にしか無い行か（main が概要に載せた行の一覧で見る）。 */
export function isOneSidedRow(summary: ExcelSheetSummaryDto | undefined, row: number): boolean {
  return summary?.conflict?.rows.includes(row) === true;
}

/** 両側にある行のセルの採り方。決まっていなければ null。 */
export function choiceForCell(state: ConflictChoiceState, sheet: number, row: number, col: number): ConflictSide | null {
  return (
    state.cells.get(cellKey(sheet, row, col)) ??
    state.rows.get(lineKey(sheet, row)) ??
    state.cols.get(lineKey(sheet, col)) ??
    state.rest
  );
}

/** 片側にしか無い行の採り方。決まっていなければ null。 */
export function choiceForRow(state: ConflictChoiceState, sheet: number, row: number): ConflictSide | null {
  return state.rows.get(lineKey(sheet, row)) ?? state.rest;
}

/** 揃えた座標の採り方（グリッドの印に使う）。片側にしか無い行は行の採り方。 */
export function choiceAt(
  summary: ExcelSheetSummaryDto | undefined,
  state: ConflictChoiceState,
  sheet: number,
  row: number,
  col: number,
): ConflictSide | null {
  return isOneSidedRow(summary, row) ? choiceForRow(state, sheet, row) : choiceForCell(state, sheet, row, col);
}

/** 決めるべき所を並び順に列挙する（片側にしか無い行は col = -1）。 */
export function* conflictTargets(summary: ExcelSheetSummaryDto): Generator<{ row: number; col: number }> {
  const c = summary.conflict;
  if (c == null) return;
  const cells = c.cells;
  let k = 0;
  let r = 0;
  for (;;) {
    const cellRow = k + 1 < cells.length ? (cells[k] ?? Infinity) : Infinity;
    const lineRow = r < c.rows.length ? (c.rows[r] ?? Infinity) : Infinity;
    if (cellRow === Infinity && lineRow === Infinity) return;
    if (lineRow < cellRow) {
      yield { row: lineRow, col: -1 };
      r += 1;
    } else {
      yield { row: cellRow, col: cells[k + 1] ?? 0 };
      k += 2;
    }
  }
}

function decided(state: ConflictChoiceState, sheet: number, t: { row: number; col: number }): ConflictSide | null {
  return t.col < 0 ? choiceForRow(state, sheet, t.row) : choiceForCell(state, sheet, t.row, t.col);
}

/** ブック全体の未決定の数。セル単位で採れない（概要に conflict が無い）なら null。 */
export function unresolvedCount(sheets: readonly ExcelSheetSummaryDto[], state: ConflictChoiceState): number | null {
  if (sheets.length === 0 || sheets.some((s) => s.conflict == null)) return null;
  let n = 0;
  for (const s of sheets) for (const t of conflictTargets(s)) if (decided(state, s.index, t) === null) n += 1;
  return n;
}

/** シートごとの未決定の数（シートタブの印）。 */
export function unresolvedInSheet(summary: ExcelSheetSummaryDto, state: ConflictChoiceState): number {
  let n = 0;
  for (const t of conflictTargets(summary)) if (decided(state, summary.index, t) === null) n += 1;
  return n;
}

/** その所で相手側を採れない理由。採れるなら null。 */
export function blockReasonAt(summary: ExcelSheetSummaryDto | undefined, row: number, col: number): ExcelBlockReasonDto | null {
  const one = isOneSidedRow(summary, row);
  for (const b of summary?.conflict?.blocked ?? []) {
    if (b.row === row && (one ? b.col === -1 : b.col === col)) return b.reason;
  }
  return null;
}

/** 相手側を採れない所に相手側が選ばれている数と、最初のもの。 */
export function blockedChoices(
  sheets: readonly ExcelSheetSummaryDto[],
  state: ConflictChoiceState,
): { readonly count: number; readonly first: (ConflictPos & { readonly reason: ExcelBlockReasonDto }) | null } {
  let count = 0;
  let first: (ConflictPos & { reason: ExcelBlockReasonDto }) | null = null;
  for (const s of sheets) {
    for (const b of s.conflict?.blocked ?? []) {
      if (decided(state, s.index, b) !== 'theirs') continue;
      count += 1;
      first ??= { sheet: s.index, row: b.row, col: Math.max(0, b.col), reason: b.reason };
    }
  }
  return { count, first };
}

/**
 * 今の位置より後ろで最初の未決定（今のシートの後ろ → 後のシート → 先頭から）。全部決まっていれば null。
 * 片側にしか無い行は列 0 を返す（行全体の指定なので列はどこでもよい）。
 */
export function nextUnresolved(
  sheets: readonly ExcelSheetSummaryDto[],
  state: ConflictChoiceState,
  from: ConflictPos | null,
): ConflictPos | null {
  const order = [...sheets].sort((a, b) => a.index - b.index);
  let first: ConflictPos | null = null;
  for (const s of order) {
    for (const t of conflictTargets(s)) {
      if (decided(state, s.index, t) !== null) continue;
      const at = { sheet: s.index, row: t.row, col: Math.max(0, t.col) };
      first ??= at;
      if (
        from === null ||
        s.index > from.sheet ||
        (s.index === from.sheet && (t.row > from.row || (t.row === from.row && t.col > from.col)))
      ) {
        return at;
      }
    }
  }
  return first;
}

export function toChoicesDto(state: ConflictChoiceState): ExcelCellChoicesDto {
  const split = (key: string): number[] => key.split(':').map(Number);
  return {
    cells: [...state.cells].map(([key, side]) => {
      const [sheet = 0, row = 0, col = 0] = split(key);
      return { sheet, row, col, side };
    }),
    rows: [...state.rows].map(([key, side]) => {
      const [sheet = 0, row = 0] = split(key);
      return { sheet, row, side };
    }),
    cols: [...state.cols].map(([key, side]) => {
      const [sheet = 0, col = 0] = split(key);
      return { sheet, col, side };
    }),
    rest: state.rest,
  };
}
