/*
 * 採り方の引きのキー（作るのはここだけ）と、送る形 ⇔ 引きの形の変換。
 */

import type { BothBlock, ChoiceMaps, ConflictChoices, ConflictSide, EffectiveChoice, BothOrder } from './types.js';

export function cellKey(sheet: number, row: number, col: number): string {
  return `${String(sheet)}:${String(row)}:${String(col)}`;
}

/** 行（`シート:行`）・列（`シート:列`）・両方を採用の範囲（`シート:先頭の行`）のキー。 */
export function lineKey(sheet: number, index: number): string {
  return `${String(sheet)}:${String(index)}`;
}

export function isBothOrder(c: EffectiveChoice | null | undefined): c is BothOrder {
  return c === 'ours-theirs' || c === 'theirs-ours';
}

/** 送る形から引きの形へ（core が使う）。 */
export function choiceMapsOf(choices: ConflictChoices): ChoiceMaps {
  const cells = new Map<string, ConflictSide>();
  const rows = new Map<string, ConflictSide>();
  const cols = new Map<string, ConflictSide>();
  const edits = new Map<string, string>();
  const hunks = new Map<string, BothBlock>();
  for (const c of choices.cells) cells.set(cellKey(c.sheet, c.row, c.col), c.side);
  for (const r of choices.rows) rows.set(lineKey(r.sheet, r.row), r.side);
  for (const c of choices.cols) cols.set(lineKey(c.sheet, c.col), c.side);
  for (const e of choices.edits ?? []) edits.set(cellKey(e.sheet, e.row, e.col), e.value);
  for (const h of choices.hunks ?? []) hunks.set(lineKey(h.sheet, h.row), { end: h.end, order: h.order });
  return { cells, rows, cols, rest: choices.rest, edits, hunks };
}

const numbers = (key: string): number[] => key.split(':').map(Number);

/** 引きの形から送る形へ（renderer が使う）。 */
export function toConflictChoices(maps: ChoiceMaps): Required<ConflictChoices> {
  return {
    cells: [...maps.cells].map(([key, side]) => {
      const [sheet = 0, row = 0, col = 0] = numbers(key);
      return { sheet, row, col, side };
    }),
    rows: [...maps.rows].map(([key, side]) => {
      const [sheet = 0, row = 0] = numbers(key);
      return { sheet, row, side };
    }),
    cols: [...maps.cols].map(([key, side]) => {
      const [sheet = 0, col = 0] = numbers(key);
      return { sheet, col, side };
    }),
    rest: maps.rest,
    edits: [...maps.edits].map(([key, value]) => {
      const [sheet = 0, row = 0, col = 0] = numbers(key);
      return { sheet, row, col, value };
    }),
    hunks: [...maps.hunks].map(([key, block]) => {
      const [sheet = 0, row = 0] = numbers(key);
      return { sheet, row, end: block.end, order: block.order };
    }),
  };
}

/** 採り方が 1 つでも決まっているか。 */
export function hasAnyChoice(maps: ChoiceMaps): boolean {
  return (
    maps.rest !== null ||
    maps.cells.size > 0 ||
    maps.rows.size > 0 ||
    maps.cols.size > 0 ||
    maps.edits.size > 0 ||
    maps.hunks.size > 0
  );
}
