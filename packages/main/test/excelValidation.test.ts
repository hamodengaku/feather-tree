import type { SheetComparison } from '@feathertree/core';
import { describe, expect, it } from 'vitest';
import { MAX_EDIT_LENGTH, validResolution, validSide } from '../src/handlers/excelValidation.js';

/*
 * Excel のコンフリクトの採用の入力検証（決定 34）。純関数なので git も session も使わない。
 * シートは「揃えた行の数」と「列の数」だけを見るので、その 2 つだけを持つ形で作る。
 */

const sheet = (rows: number, cols: number): SheetComparison =>
  ({ oldRow: new Int32Array(rows), colCount: cols }) as unknown as SheetComparison;
const SHEETS = [sheet(5, 3), sheet(2, 2)];
const EMPTY = { cells: [], rows: [], cols: [], rest: null };

/** 投げた HandlerError の dto（投げなければ null）。 */
function errorOf(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (err) {
    return (err as { dto?: unknown }).dto ?? err;
  }
}

const cells = (choices: object): unknown => validResolution({ kind: 'cells', choices: { ...EMPTY, ...choices } }, SHEETS);

describe('Excel のコンフリクトの採用の入力検証（決定 34）', () => {
  it('ファイル単位は側だけを通す', () => {
    expect(validResolution({ kind: 'file', side: 'theirs' }, SHEETS)).toEqual({ kind: 'file', side: 'theirs' });
    expect(errorOf(() => validResolution({ kind: 'file', side: 'base' }, SHEETS))).toMatchObject({ kind: 'internal' });
    expect(errorOf(() => validResolution({ kind: 'other' }, SHEETS))).toMatchObject({ kind: 'internal' });
    expect(errorOf(() => validResolution(null, SHEETS))).toMatchObject({ kind: 'internal' });
    expect(errorOf(() => validSide('ours-theirs'))).toMatchObject({ kind: 'internal' });
  });

  it('範囲内の座標・側・並び・打った値はそのまま通す（省略した edits / hunks は空）', () => {
    expect(
      cells({
        cells: [{ sheet: 0, row: 4, col: 2, side: 'ours' }],
        rows: [{ sheet: 1, row: 1, side: 'theirs' }],
        cols: [{ sheet: 1, col: 1, side: 'ours' }],
        rest: 'theirs',
        edits: [{ sheet: 0, row: 0, col: 0, value: "'012" }],
        hunks: [{ sheet: 0, row: 1, end: 5, order: 'theirs-ours' }],
      }),
    ).toEqual({
      kind: 'cells',
      choices: {
        cells: [{ sheet: 0, row: 4, col: 2, side: 'ours' }],
        rows: [{ sheet: 1, row: 1, side: 'theirs' }],
        cols: [{ sheet: 1, col: 1, side: 'ours' }],
        rest: 'theirs',
        edits: [{ sheet: 0, row: 0, col: 0, value: "'012" }],
        hunks: [{ sheet: 0, row: 1, end: 5, order: 'theirs-ours' }],
      },
    });
    expect(cells({})).toEqual({ kind: 'cells', choices: { ...EMPTY, edits: [], hunks: [] } });
  });

  it('範囲外・整数でない座標、無いシートは断る', () => {
    for (const bad of [
      { cells: [{ sheet: 0, row: 5, col: 0, side: 'ours' }] },
      { cells: [{ sheet: 0, row: 0, col: 3, side: 'ours' }] },
      { cells: [{ sheet: 0, row: 1.5, col: 0, side: 'ours' }] },
      { cells: [{ sheet: 2, row: 0, col: 0, side: 'ours' }] },
      { rows: [{ sheet: 1, row: -1, side: 'ours' }] },
      { cols: [{ sheet: 1, col: 2, side: 'ours' }] },
      { rows: [{ sheet: '0', row: 0, side: 'ours' }] },
    ]) {
      expect(errorOf(() => cells(bad))).toMatchObject({ kind: 'internal' });
    }
  });

  it('行の指定は片側だけ（両方の採用は hunks で）', () => {
    expect(errorOf(() => cells({ rows: [{ sheet: 0, row: 1, side: 'ours-theirs' }] }))).toMatchObject({ kind: 'internal' });
  });

  it('両方を採用の範囲は end > row かつシートの行数以内、並びは 2 種だけ', () => {
    expect(errorOf(() => cells({ hunks: [{ sheet: 0, row: 2, end: 2, order: 'ours-theirs' }] }))).toMatchObject({ kind: 'internal' });
    expect(errorOf(() => cells({ hunks: [{ sheet: 0, row: 2, end: 6, order: 'ours-theirs' }] }))).toMatchObject({ kind: 'internal' });
    expect(errorOf(() => cells({ hunks: [{ sheet: 0, row: 2, end: 3, order: 'ours' }] }))).toMatchObject({ kind: 'internal' });
  });

  it('打った値は文字列で、Excel の 1 セルの上限まで。NUL は断る', () => {
    const at = { sheet: 0, row: 0, col: 0 };
    expect(cells({ edits: [{ ...at, value: 'x'.repeat(MAX_EDIT_LENGTH) }] })).toMatchObject({ kind: 'cells' });
    expect(errorOf(() => cells({ edits: [{ ...at, value: 'x'.repeat(MAX_EDIT_LENGTH + 1) }] }))).toMatchObject({ kind: 'internal' });
    expect(errorOf(() => cells({ edits: [{ ...at, value: 'a' + String.fromCharCode(0) }] }))).toMatchObject({ kind: 'internal' });
    expect(errorOf(() => cells({ edits: [{ ...at, value: 1 }] }))).toMatchObject({ kind: 'internal' });
  });

  it('配列でない・形の違う指定は断る', () => {
    expect(errorOf(() => cells({ cells: null }))).toMatchObject({ kind: 'internal' });
    expect(errorOf(() => cells({ hunks: {} }))).toMatchObject({ kind: 'internal' });
    expect(errorOf(() => validResolution({ kind: 'cells', choices: null }, SHEETS))).toMatchObject({ kind: 'internal' });
  });
});
