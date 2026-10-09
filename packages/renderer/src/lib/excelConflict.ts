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

import type {
  ExcelBlockReasonDto,
  ExcelBothOrderDto,
  ExcelCellChoicesDto,
  ExcelConflictSideDto,
  ExcelSheetSummaryDto,
} from '@feathertree/ipc';

export type ConflictSide = ExcelConflictSideDto;
/** 両方を採用するときの並び（docs/07 7.2）。 */
export type BothOrder = ExcelBothOrderDto;
/** 両方を採用する範囲の終わり（含まない）と並び。 */
export interface BothBlock {
  readonly end: number;
  readonly order: BothOrder;
}

/** 行の指定。両側にある行なら、両方を採用して 2 行に分けられる。 */
export type RowChoice = ConflictSide | BothOrder;
/** 効いている採り方。edit は利用者が打った値（docs/07 7.1）、ours-theirs / theirs-ours は両方を採用（7.2）。 */
export type ConflictChoice = ConflictSide | 'edit' | BothOrder;

export function isBothOrder(c: RowChoice | ConflictChoice | null | undefined): c is BothOrder {
  return c === 'ours-theirs' || c === 'theirs-ours';
}

export interface ConflictChoiceState {
  /** キーは `シート:揃えた行:列`。 */
  readonly cells: ReadonlyMap<string, ConflictSide>;
  /** キーは `シート:揃えた行`。 */
  readonly rows: ReadonlyMap<string, RowChoice>;
  /** キーは `シート:列`。 */
  readonly cols: ReadonlyMap<string, ConflictSide>;
  readonly rest: ConflictSide | null;
  /** 打った値。キーは `シート:揃えた行:列`。セルの指定より強い。 */
  readonly edits: ReadonlyMap<string, string>;
  /**
   * 続いた行の範囲 [start, end) で両方を採用。キーは `シート:start`。範囲の中のどの指定よりも強い（docs/07 7.2）。
   */
  readonly hunks: ReadonlyMap<string, BothBlock>;
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

/** 決めるべき所のある揃えた行の集合（ブロックの区切りに使う）。概要ごとに 1 回だけ作る。 */
const targetRowsCache = new WeakMap<object, ReadonlySet<number>>();

function targetRows(summary: ExcelSheetSummaryDto): ReadonlySet<number> {
  const c = summary.conflict;
  if (c == null) return new Set();
  const cached = targetRowsCache.get(c);
  if (cached !== undefined) return cached;
  const rows = new Set<number>(c.rows);
  for (let k = 0; k + 1 < c.cells.length; k += 2) rows.add(c.cells[k] ?? 0);
  targetRowsCache.set(c, rows);
  return rows;
}

/**
 * その行が属するブロック（決めるべき所のある行が続く区間）の先頭。決めるべき所の無い行なら -1。
 * main の hunkStartsOf と同じ区切り方。
 */
export function hunkStartOf(summary: ExcelSheetSummaryDto | undefined, row: number): number {
  if (summary === undefined) return -1;
  const rows = targetRows(summary);
  if (!rows.has(row)) return -1;
  let start = row;
  while (rows.has(start - 1)) start -= 1;
  return start;
}

/** ブロックの終わり（含まない）。 */
export function hunkEndOf(summary: ExcelSheetSummaryDto, start: number): number {
  const rows = targetRows(summary);
  let end = start;
  while (rows.has(end)) end += 1;
  return end;
}

/** その行を含む「両方を採用」の範囲。無ければ null。 */
export function bothBlockAt(state: ConflictChoiceState, sheet: number, row: number): (BothBlock & { start: number }) | null {
  const prefix = String(sheet) + ':';
  for (const [key, block] of state.hunks) {
    if (!key.startsWith(prefix)) continue;
    const start = Number(key.slice(prefix.length));
    if (row >= start && row < block.end) return { ...block, start };
  }
  return null;
}

function hunkChoice(state: ConflictChoiceState, summary: ExcelSheetSummaryDto | undefined, sheet: number, row: number): BothOrder | null {
  if (state.hunks.size === 0 || hunkStartOf(summary, row) < 0) return null;
  return bothBlockAt(state, sheet, row)?.order ?? null;
}

/** 両側にある行のセルの採り方。決まっていなければ null。summary を渡せばブロックの指定も見る。 */
export function choiceForCell(
  state: ConflictChoiceState,
  sheet: number,
  row: number,
  col: number,
  summary?: ExcelSheetSummaryDto,
): ConflictChoice | null {
  const hunk = hunkChoice(state, summary, sheet, row);
  if (hunk !== null) return hunk;
  const rowChoice = state.rows.get(lineKey(sheet, row));
  if (isBothOrder(rowChoice)) return rowChoice;
  if (state.edits.has(cellKey(sheet, row, col))) return 'edit';
  return state.cells.get(cellKey(sheet, row, col)) ?? rowChoice ?? state.cols.get(lineKey(sheet, col)) ?? state.rest;
}

/** 片側にしか無い行の採り方。決まっていなければ null。 */
export function choiceForRow(
  state: ConflictChoiceState,
  sheet: number,
  row: number,
  summary?: ExcelSheetSummaryDto,
): ConflictChoice | null {
  return hunkChoice(state, summary, sheet, row) ?? state.rows.get(lineKey(sheet, row)) ?? state.rest;
}

/** 揃えた座標の採り方（グリッドの印に使う）。片側にしか無い行は行の採り方。 */
export function choiceAt(
  summary: ExcelSheetSummaryDto | undefined,
  state: ConflictChoiceState,
  sheet: number,
  row: number,
  col: number,
): ConflictChoice | null {
  return isOneSidedRow(summary, row) ? choiceForRow(state, sheet, row, summary) : choiceForCell(state, sheet, row, col, summary);
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

function decided(state: ConflictChoiceState, summary: ExcelSheetSummaryDto, t: { row: number; col: number }): ConflictChoice | null {
  const sheet = summary.index;
  return t.col < 0 ? choiceForRow(state, sheet, t.row, summary) : choiceForCell(state, sheet, t.row, t.col, summary);
}

/** ブック全体の未決定の数。セル単位で採れない（概要に conflict が無い）なら null。 */
export function unresolvedCount(sheets: readonly ExcelSheetSummaryDto[], state: ConflictChoiceState): number | null {
  if (sheets.length === 0 || sheets.some((s) => s.conflict == null)) return null;
  let n = 0;
  for (const s of sheets) for (const t of conflictTargets(s)) if (decided(state, s, t) === null) n += 1;
  return n;
}

/** シートごとの未決定の数（シートタブの印）。 */
export function unresolvedInSheet(summary: ExcelSheetSummaryDto, state: ConflictChoiceState): number {
  let n = 0;
  for (const t of conflictTargets(summary)) if (decided(state, summary, t) === null) n += 1;
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
      // 打った値も、相手側を採るのと同じく書けない所がある（配列数式・テーブルの見出し）
      const d = decided(state, s, b);
      if (d === null || d === 'ours') continue;
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
      if (decided(state, s, t) !== null) continue;
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
    hunks: [...state.hunks].map(([key, block]) => {
      const [sheet = 0, row = 0] = split(key);
      return { sheet, row, end: block.end, order: block.order };
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
    edits: [...state.edits].map(([key, value]) => {
      const [sheet = 0, row = 0, col = 0] = split(key);
      return { sheet, row, col, value };
    }),
  };
}

/** 範囲（揃えた座標・両端を含む）。 */
export interface CellRange {
  readonly r1: number;
  readonly c1: number;
  readonly r2: number;
  readonly c2: number;
}

export function rangeOf(a: { row: number; col: number }, b: { row: number; col: number }): CellRange {
  return { r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col), r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col) };
}

export function inRanges(ranges: readonly CellRange[], row: number, col: number): boolean {
  return ranges.some((r) => row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2);
}

/** 選んだ範囲に含まれる決めるべき所。片側にしか無い行は、範囲がその行に掛かっていれば含める。 */
export function targetsInRanges(
  summary: ExcelSheetSummaryDto | undefined,
  ranges: readonly CellRange[],
): { readonly cells: readonly { row: number; col: number }[]; readonly rows: readonly number[] } {
  const cells: { row: number; col: number }[] = [];
  const rows: number[] = [];
  if (summary === undefined) return { cells, rows };
  for (const t of conflictTargets(summary)) {
    if (t.col < 0) {
      if (ranges.some((r) => t.row >= r.r1 && t.row <= r.r2)) rows.push(t.row);
    } else if (inRanges(ranges, t.row, t.col)) {
      cells.push(t);
    }
  }
  return { cells, rows };
}

/**
 * 範囲が掛かっている「決めるべき所のある行」を、ブロックごとの続いた範囲 [start, end) にまとめる（両方を採用の単位）。
 */
export function blocksInRanges(summary: ExcelSheetSummaryDto | undefined, ranges: readonly CellRange[]): { start: number; end: number }[] {
  if (summary === undefined) return [];
  const byHunk = new Map<number, { start: number; end: number }>();
  for (const row of targetRows(summary)) {
    if (!ranges.some((r) => row >= r.r1 && row <= r.r2)) continue;
    const hunk = hunkStartOf(summary, row);
    const b = byHunk.get(hunk);
    if (b === undefined) byHunk.set(hunk, { start: row, end: row + 1 });
    else byHunk.set(hunk, { start: Math.min(b.start, row), end: Math.max(b.end, row + 1) });
  }
  return [...byHunk.values()].sort((a, b) => a.start - b.start);
}
