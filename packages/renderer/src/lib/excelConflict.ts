/*
 * Excel 差分モードのコンフリクト（決定 34）の、画面側の補助。**純関数だけ。**
 *
 * 採り方の規則（優先順位・ブロック・両方を採用・書き込み後の行の並び）は @feathertree/conflict-plan にあり、
 * 書き込み（core）と同じものを使う。ここにあるのは、シートの概要からその規則を作ることと、選んだ範囲の扱いだけ。
 *
 * 決めるべき所と相手側を採れない所は、main がシートの概要（ExcelSheetSummaryDto.conflict）に載せてくる。
 * ここで数える「未決定」「採れない所に相手側」は画面の案内のため。書き込んでよいかは main がやり直す。
 */

import { SheetRules, TargetIndex, type ChoiceMaps } from '@feathertree/conflict-plan';
import type { ExcelSheetSummaryDto } from '@feathertree/ipc';

/** シートの採り方の規則。セル単位で採れない（概要に conflict が無い）なら null。 */
export function rulesFor(summary: ExcelSheetSummaryDto | null | undefined, choices: ChoiceMaps): SheetRules | null {
  const targets = summary?.conflict;
  return summary == null || targets == null ? null : new SheetRules(summary.index, targets, choices);
}

/** ブック全体の規則（シートの順）。どれか 1 枚でもセル単位で採れなければ null。 */
export function bookRules(sheets: readonly ExcelSheetSummaryDto[], choices: ChoiceMaps): SheetRules[] | null {
  if (sheets.length === 0) return null;
  const out: SheetRules[] = [];
  for (const s of [...sheets].sort((a, b) => a.index - b.index)) {
    const rules = rulesFor(s, choices);
    if (rules === null) return null;
    out.push(rules);
  }
  return out;
}

/** シートの決めるべき所の引き。セル単位で採れなければ null。 */
export function targetIndexOf(summary: ExcelSheetSummaryDto | null | undefined): TargetIndex | null {
  const targets = summary?.conflict;
  return targets == null ? null : TargetIndex.of(targets);
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

const rowInRanges = (ranges: readonly CellRange[], row: number): boolean => ranges.some((r) => row >= r.r1 && row <= r.r2);

/** 選んだ範囲に含まれる決めるべき所。片側にしか無い行は、範囲がその行に掛かっていれば含める。 */
export function targetsInRanges(
  index: TargetIndex | null,
  ranges: readonly CellRange[],
): { readonly cells: readonly { row: number; col: number }[]; readonly rows: readonly number[] } {
  const cells: { row: number; col: number }[] = [];
  const rows: number[] = [];
  if (index === null) return { cells, rows };
  for (const t of index.targets()) {
    if (t.col < 0) {
      if (rowInRanges(ranges, t.row)) rows.push(t.row);
    } else if (inRanges(ranges, t.row, t.col)) {
      cells.push({ row: t.row, col: t.col });
    }
  }
  return { cells, rows };
}

/**
 * 範囲が掛かっている「決めるべき所のある行」を、ブロックごとの続いた範囲 [start, end) にまとめる（両方を採用の単位）。
 */
export function blocksInRanges(index: TargetIndex | null, ranges: readonly CellRange[]): { start: number; end: number }[] {
  if (index === null) return [];
  const byHunk = new Map<number, { start: number; end: number }>();
  for (const row of index.rows) {
    if (!rowInRanges(ranges, row)) continue;
    const hunk = index.hunkStart(row);
    const b = byHunk.get(hunk);
    if (b === undefined) byHunk.set(hunk, { start: row, end: row + 1 });
    else byHunk.set(hunk, { start: Math.min(b.start, row), end: Math.max(b.end, row + 1) });
  }
  return [...byHunk.values()].sort((a, b) => a.start - b.start);
}
