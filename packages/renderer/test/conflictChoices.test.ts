import { describe, expect, it } from 'vitest';
import type { ExcelViewDto } from '@feathertree/ipc';
import { ConflictChoices } from '../src/lib/conflictChoices.svelte.js';

/*
 * Excel 差分モードのコンフリクトの採り方の入れ物（決定 34）。片側・両方を採用・打った値の当て方と、持ち越しの鍵。
 */

const view = (path: string, fingerprint: string, source: 'markers' | 'stages' = 'stages'): ExcelViewDto =>
  ({ path, conflict: { source, cellResolvable: true, fingerprint } }) as unknown as ExcelViewDto;

describe('コンフリクトの採り方', () => {
  it('片側を当てると、打った値と掛かる両方を採用を外す。null なら個別の指定を外す', () => {
    const c = new ConflictChoices();
    c.setEdit(0, 1, 1, 'x');
    c.applyBoth(0, [{ start: 1, end: 3 }], 'ours-theirs');
    c.applySide(0, { cells: [{ row: 1, col: 1 }], rows: [2] }, [{ start: 1, end: 2 }], 'theirs');
    expect(c.cells.get('0:1:1')).toBe('theirs');
    expect(c.rows.get('0:2')).toBe('theirs');
    expect(c.edits.size).toBe(0);
    expect(c.hunks.size).toBe(0);
    c.applySide(0, { cells: [{ row: 1, col: 1 }], rows: [2] }, [], null);
    expect(c.cells.size + c.rows.size).toBe(0);
  });

  it('両方を採用は同じ範囲・並びをもう一度当てると外れ、重なる範囲は置き換える', () => {
    const c = new ConflictChoices();
    c.applyBoth(0, [{ start: 2, end: 4 }], 'theirs-ours');
    expect(c.hunks.get('0:2')).toEqual({ end: 4, order: 'theirs-ours' });
    c.applyBoth(0, [{ start: 3, end: 5 }], 'ours-theirs');
    expect([...c.hunks.keys()]).toEqual(['0:3']);
    c.applyBoth(0, [{ start: 3, end: 5 }], 'ours-theirs');
    expect(c.hunks.size).toBe(0);
    // 別のシートの範囲には触れない
    c.applyBoth(1, [{ start: 3, end: 5 }], 'ours-theirs');
    c.dropBoth(0, 0, 10);
    expect([...c.hunks.keys()]).toEqual(['1:3']);
  });

  it('送る形は座標と側・打った値・両方を採用だけ', () => {
    const c = new ConflictChoices();
    c.cells.set('1:1:2', 'theirs');
    c.rest = 'ours';
    c.setEdit(0, 1, 1, '42');
    expect(c.toDto()).toEqual({
      cells: [{ sheet: 1, row: 1, col: 2, side: 'theirs' }],
      rows: [],
      cols: [],
      rest: 'ours',
      edits: [{ sheet: 0, row: 1, col: 1, value: '42' }],
      hunks: [],
    });
  });

  it('同じファイルの同じ比較の間だけ持ち越し、指紋・ファイル・出どころが替われば捨てる', () => {
    const c = new ConflictChoices();
    c.sync(view('a.xlsx', 'f1'));
    c.rest = 'theirs';
    c.sync(view('a.xlsx', 'f1'));
    expect(c.rest).toBe('theirs');
    c.sync(view('b.xlsx', 'f1'));
    expect(c.rest).toBeNull();
    c.rest = 'ours';
    c.sync(view('b.xlsx', 'f1', 'markers'));
    expect(c.rest).toBeNull();
    c.rest = 'ours';
    c.forget();
    expect(c.rest).toBeNull();
  });
});
