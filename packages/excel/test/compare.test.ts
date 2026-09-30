import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  HIDDEN_NEW,
  HIDDEN_OLD,
  ROW_ADDED,
  ROW_CHANGED,
  ROW_REMOVED,
  ROW_SAME,
  alignRows,
  buildGeometry,
  buildRowDiff,
  buildRowPage,
  cellDetail,
  compareWorkbooks,
  openWorkbook,
  type Workbook,
  type WorkbookComparison,
} from '../src/index.js';
import { buildXlsx, type BookSpec, type CellSpec } from './xlsxBuilder.js';
import { identityInflater } from './zipBuilder.js';

function book(spec: BookSpec): Workbook {
  const r = openWorkbook(buildXlsx(spec), identityInflater);
  if (!r.ok) throw new Error('open failed: ' + r.reason);
  return r.workbook;
}

function one(rows: readonly (readonly CellSpec[])[], name = 'a'): Workbook {
  return book({ sheets: [{ name, rows }] });
}

/** 揃えた行を「旧番号/新番号」の文字列で見る（無い側は -）。 */
function pairs(a: ArrayLike<number>, b: ArrayLike<number>): string[] {
  const out: string[] = [];
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    out.push(`${x < 0 ? '-' : String(x)}/${y < 0 ? '-' : String(y)}`);
  }
  return out;
}

describe('行の対応付け（EA-2）', () => {
  const align = (a: number[], b: number[], limits = DEFAULT_LIMITS) => alignRows(a, b, limits);

  it('同じ並びはそのまま対になる', () => {
    const r = align([1, 2, 3], [1, 2, 3]);
    expect(pairs(r.oldRow, r.newRow)).toEqual(['0/0', '1/1', '2/2']);
  });

  it('挿入と削除は相手側を空ける', () => {
    const ins = align([1, 2, 3], [1, 9, 2, 3]);
    expect(pairs(ins.oldRow, ins.newRow)).toEqual(['0/0', '-/1', '1/2', '2/3']);
    const del = align([1, 2, 3], [1, 3]);
    expect(pairs(del.oldRow, del.newRow)).toEqual(['0/0', '1/-', '2/1']);
  });

  it('削除と挿入が並べば、先頭から「変更」の対にする', () => {
    const r = align([1, 2, 3, 4], [1, 7, 8, 9, 4]);
    expect(pairs(r.oldRow, r.newRow)).toEqual(['0/0', '1/1', '2/2', '-/3', '3/4']);
  });

  it('似かたが渡されれば、挿入した行ではなく似ている行と対にする', () => {
    // 旧 1 行（添字 1）が新 2 行（添字 1, 2）に置き換わった。似ているのは新の 2
    const sim = (o: number, n: number): number => (o === 1 && n === 2 ? 0.9 : 0);
    const r = alignRows([1, 2, 3], [1, 8, 9, 3], DEFAULT_LIMITS, sim);
    expect(pairs(r.oldRow, r.newRow)).toEqual(['0/0', '-/1', '1/2', '2/3']);
    // 似た組が無く同数なら、先頭から順に対にする
    const same = alignRows([1, 2, 3], [1, 8, 3], DEFAULT_LIMITS, () => 0);
    expect(pairs(same.oldRow, same.newRow)).toEqual(['0/0', '1/1', '2/2']);
    // 似た組が無く数が違えば、削除と追加に分ける
    const split = alignRows([1, 2, 3], [1, 8, 9, 3], DEFAULT_LIMITS, () => 0);
    expect(pairs(split.oldRow, split.newRow)).toEqual(['0/0', '1/-', '-/1', '-/2', '2/3']);
  });

  it('重複した行（空行）があっても、一意な行をアンカーに揃う', () => {
    // 0 は空行（何度も現れる）。10, 20, 30 は一意
    const r = align([10, 0, 0, 20, 0, 30], [10, 0, 5, 0, 20, 0, 30]);
    const p = pairs(r.oldRow, r.newRow);
    expect(p).toContain('0/0');
    expect(p).toContain('3/4');
    expect(p).toContain('5/6');
  });

  it('行の移動はアンカーの順序で片方を残す', () => {
    const r = align([1, 2, 3, 4, 5], [1, 4, 2, 3, 5]);
    const p = pairs(r.oldRow, r.newRow);
    // 1, 5 は動かず、2, 3 は順序を保って対になる
    expect(p).toContain('0/0');
    expect(p).toContain('1/2');
    expect(p).toContain('2/3');
    expect(p).toContain('4/4');
  });

  it('予算を超えたら位置で対にして印を立てる', () => {
    const a = Array.from({ length: 50 }, (_, i) => i + 1);
    const b = Array.from({ length: 50 }, (_, i) => i + 1000).reverse();
    const r = align(a, b, { ...DEFAULT_LIMITS, maxAlignEdits: 5 });
    expect(r.positional).toBe(true);
    expect(r.oldRow.length).toBe(50);
    expect(pairs(r.oldRow, r.newRow)[0]).toBe('0/0');
  });

  it('片側が空', () => {
    expect(pairs(align([], [1, 2]).oldRow, align([], [1, 2]).newRow)).toEqual(['-/0', '-/1']);
    expect(pairs(align([1], []).oldRow, align([1], []).newRow)).toEqual(['0/-']);
  });

  it('大きめのランダムな編集でも、両側の全行がちょうど 1 回ずつ現れる', () => {
    let seed = 7;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const a = Array.from({ length: 400 }, () => Math.floor(rand() * 60));
    const b = a.filter(() => rand() > 0.1).map((v) => (rand() > 0.9 ? v + 100 : v));
    for (let i = 0; i < 30; i += 1) b.splice(Math.floor(rand() * b.length), 0, 999);
    const r = align(a, b);
    const seenA = [...r.oldRow].filter((v) => v >= 0);
    const seenB = [...r.newRow].filter((v) => v >= 0);
    expect(seenA).toEqual(a.map((_, i) => i));
    expect(seenB).toEqual(b.map((_, i) => i));
  });
});

describe('ブックの比較（決定 33）', () => {
  const header = ['品名', '単価', '数量'];

  it('値の変更・行の挿入を、揃えた行の状態として出す', () => {
    const before = one([header, ['剣', 1000, 3], ['盾', 800, 5]]);
    const after = one([header, ['剣', 1200, 3], ['弓', 600, 2], ['盾', 800, 5]]);
    const cmp = compareWorkbooks(before, after);
    const sheet = cmp.sheets[0];
    if (sheet === undefined) throw new Error('sheet');
    expect(sheet.mark).toBe('changed');
    expect([...sheet.rowState]).toEqual([ROW_SAME, ROW_CHANGED, ROW_ADDED, ROW_SAME]);
    expect(pairs(sheet.oldRow, sheet.newRow)).toEqual(['0/0', '1/1', '-/2', '2/3']);
    expect(sheet.changedCells).toBe(1 + 3);
    expect(sheet.addedRows).toBe(1);
    expect(sheet.changedRowCount).toBe(1);
    expect([...sheet.changedRows]).toEqual([1, 2]);
  });

  it('共有文字列の添字が違っても、本文が同じなら同じ', () => {
    const a = book({ sheets: [{ name: 'a', rows: [['x', 'y']] }] });
    const b = book({ sheets: [{ name: 'a', rows: [['y', 'x']] }, { name: 'b', rows: [] }] });
    const c = book({ sheets: [{ name: 'a', rows: [['x', 'y']] }] , inlineStrings: true });
    expect(compareWorkbooks(a, c).sheets[0]?.mark).toBe('same');
    expect(compareWorkbooks(a, b).sheets[0]?.mark).toBe('changed');
  });

  it('数式だけの変更も変更。書式だけの違いは変更に数えない', () => {
    const a = one([[1, { f: 'A1+1', v: 2 }]]);
    const b = one([[1, { f: 'A1*2', v: 2 }]]);
    expect(compareWorkbooks(a, b).sheets[0]?.mark).toBe('changed');
    const styled = book({
      sheets: [{ name: 'a', xml: '<worksheet><sheetData><row r="1"><c r="A1" s="4"><v>1</v></c><c r="B1" s="2"/></row></sheetData></worksheet>' }],
    });
    expect(compareWorkbooks(one([[1]]), styled).sheets[0]?.mark).toBe('same');
  });

  it('シートの追加・削除・名前の変更。並びは新側の順で、削除は旧側の位置に入る', () => {
    const a = book({ sheets: [{ name: 'A', sheetId: 1, rows: [[1]] }, { name: 'B', sheetId: 2, rows: [[2]] }, { name: 'C', sheetId: 3, rows: [[3]] }] });
    const b = book({ sheets: [{ name: 'A', sheetId: 1, rows: [[1]] }, { name: 'C2', sheetId: 3, rows: [[3]] }, { name: 'D', sheetId: 4, rows: [[4]] }] });
    const cmp = compareWorkbooks(a, b);
    expect(cmp.sheets.map((s) => [s.old?.name ?? null, s.new?.name ?? null, s.mark, s.renamed])).toEqual([
      ['A', 'A', 'same', false],
      ['B', null, 'removed', false],
      ['C', 'C2', 'same', true],
      [null, 'D', 'added', false],
    ]);
  });

  it('sheetId が振り直されても、名前が同じなら同じシートとして対にする', () => {
    const a = book({ sheets: [{ name: 'X', sheetId: 1, rows: [[1]] }, { name: 'Y', sheetId: 2, rows: [[2]] }] });
    const b = book({ sheets: [{ name: 'X', sheetId: 2, rows: [[1]] }, { name: 'Y', sheetId: 1, rows: [[2]] }] });
    expect(compareWorkbooks(a, b).sheets.map((s) => s.mark)).toEqual(['same', 'same']);
  });

  it('片側が無い（新規ファイル・削除）', () => {
    const b = one([['a'], ['b']]);
    const cmp = compareWorkbooks(null, b);
    expect(cmp.sheets[0]?.mark).toBe('added');
    expect([...(cmp.sheets[0]?.rowState ?? [])]).toEqual([ROW_ADDED, ROW_ADDED]);
    const gone = compareWorkbooks(b, null);
    expect(gone.sheets[0]?.mark).toBe('removed');
    expect([...(gone.sheets[0]?.rowState ?? [])]).toEqual([ROW_REMOVED, ROW_REMOVED]);
  });

  it('マクロの変化', () => {
    const a = book({ sheets: [{ name: 'a', rows: [[1]] }], vba: 'one' });
    const b = book({ sheets: [{ name: 'a', rows: [[1]] }], vba: 'two' });
    expect(compareWorkbooks(a, b).vbaChanged).toBe(true);
    expect(compareWorkbooks(a, a).vbaChanged).toBe(false);
    expect(compareWorkbooks(one([[1]]), one([[1]])).vbaChanged).toBeNull();
  });
});

describe('幾何・ページ・セル詳細（EA-3 / EA-4）', () => {
  function cmpOf(a: BookSpec, b: BookSpec): WorkbookComparison {
    return compareWorkbooks(book(a), book(b));
  }

  it('行の高さは対の大きいほう、列幅は列ごとの大きいほう。非表示は印だけ', () => {
    const cmp = cmpOf(
      { sheets: [{ name: 'a', rows: [[1, 2], [3, 4]], rowHeights: { 0: 30 }, hiddenRows: [1], cols: '<cols><col min="1" max="1" width="10.7109375"/></cols>' }] },
      { sheets: [{ name: 'a', rows: [[1, 2], [3, 5]], rowHeights: { 1: 45 }, cols: '<cols><col min="2" max="2" width="30.7109375"/></cols>' }] },
    );
    const sheet = cmp.sheets[0];
    if (sheet === undefined) throw new Error('sheet');
    const g = buildGeometry(sheet);
    expect(g.rowCount).toBe(2);
    expect([...g.rowHeightPx]).toEqual([40, 60]);
    expect([...g.rowHidden]).toEqual([0, HIDDEN_OLD]);
    expect([...g.colWidthPx]).toEqual([75, 215]);
    expect(g.colHidden[0]).toBe(0);
    expect(HIDDEN_NEW).toBe(2);
  });

  it('結合は揃えた座標に直す（片側に行が挿入されても）', () => {
    const cmp = cmpOf(
      { sheets: [{ name: 'a', rows: [['h'], ['x'], ['y']], merges: ['A2:B3'] }] },
      { sheets: [{ name: 'a', rows: [['h'], ['new'], ['x'], ['y']], merges: ['A3:B4'] }] },
    );
    const sheet = cmp.sheets[0];
    if (sheet === undefined) throw new Error('sheet');
    const g = buildGeometry(sheet);
    expect([...g.oldMerges]).toEqual([2, 0, 3, 1]);
    expect([...g.newMerges]).toEqual([2, 0, 3, 1]);
  });

  it('行ページは見えている範囲の表示文字と変わった列を返す', () => {
    const cmp = cmpOf(
      { sheets: [{ name: 'a', rows: [['a', 1], ['b', 2]] }] },
      { sheets: [{ name: 'a', rows: [['a', 1], ['b', 3]] }] },
    );
    const sheet = cmp.sheets[0];
    if (sheet === undefined) throw new Error('sheet');
    const page = buildRowPage(cmp, sheet, 1, 10, 100);
    expect(page).toHaveLength(1);
    expect(page[0]?.old?.text).toEqual(['b', '2']);
    expect(page[0]?.new?.text).toEqual(['b', '3']);
    expect([...(page[0]?.changedCols ?? [])]).toEqual([1]);
    expect(page[0]?.old?.row).toBe(1);
  });

  it('セル詳細は番地・生の値・数式を両側分返す', () => {
    const cmp = cmpOf(
      { sheets: [{ name: 'a', rows: [[0.1, { f: 'A1*2', v: 0.2 }]] }] },
      { sheets: [{ name: 'a', rows: [['new'], [0.1, { f: 'A2*3', v: 0.30000000000000004 }]] }] },
    );
    const sheet = cmp.sheets[0];
    if (sheet === undefined) throw new Error('sheet');
    const row = [...sheet.newRow].indexOf(1);
    const d = cellDetail(cmp, sheet, row, 1);
    expect(d.changed).toBe(true);
    expect(d.old?.address).toBe('B1');
    expect(d.new?.address).toBe('B2');
    expect(d.old?.formula).toBe('A1*2');
    expect(d.new?.formula).toBe('A2*3');
    expect(d.new?.raw).toBe('0.30000000000000004');
    expect(d.new?.display).toBe('0.3');
  });
});

describe('行単位の比較（要件 E5）', () => {
  it('変わった行と前後の文脈行を hunk にし、近い hunk はつなぐ', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [`r${String(i)}`, i]);
    const changed = rows.map((r) => [...r]);
    (changed[5] as unknown[])[1] = 500;
    (changed[8] as unknown[])[1] = 800;
    (changed[18] as unknown[])[1] = 1800;
    const cmp = compareWorkbooks(one(rows as CellSpec[][]), one(changed as CellSpec[][]));
    const diff = buildRowDiff(cmp, 2);
    const hunks = diff.sheets[0]?.hunks ?? [];
    expect(hunks.map((h) => [h.rows[0]?.newRow, h.rows[h.rows.length - 1]?.newRow])).toEqual([
      [3, 10],
      [16, 19],
    ]);
    expect(hunks[0]?.columns).toEqual([0, 1]);
    const row5 = hunks[0]?.rows.find((r) => r.newRow === 5);
    expect(row5?.kind).toBe('changed');
    expect(row5?.old).toEqual(['r5', '5']);
    expect(row5?.new).toEqual(['r5', '500']);
    expect(row5?.changed).toEqual([1]);
    expect(diff.truncated).toBe(false);
  });

  it('変化の無いシートは出さず、行の上限で打ち切る', () => {
    const a = book({ sheets: [{ name: 's', rows: [[1]] }, { name: 't', rows: [[1], [2], [3]] }] });
    const b = book({ sheets: [{ name: 's', rows: [[1]] }, { name: 't', rows: [[9], [8], [7]] }] });
    const cmp = compareWorkbooks(a, b);
    const full = buildRowDiff(cmp, 0);
    expect(full.sheets.map((s) => s.newName)).toEqual(['t']);
    const cut = buildRowDiff(cmp, 0, { ...DEFAULT_LIMITS, maxRowDiffLines: 2 });
    expect(cut.truncated).toBe(true);
    expect(cut.sheets[0]?.hunks.reduce((n, h) => n + h.rows.length, 0)).toBe(2);
  });

  it('列が多すぎれば、変わった列を優先して上限まで残す', () => {
    const wide = Array.from({ length: 10 }, (_, i) => i);
    const changed = [...wide];
    changed[9] = 99;
    const cmp = compareWorkbooks(one([wide]), one([changed]));
    const diff = buildRowDiff(cmp, 0, { ...DEFAULT_LIMITS, maxRowDiffColumns: 3 });
    const hunk = diff.sheets[0]?.hunks[0];
    expect(hunk?.columns).toContain(9);
    expect(hunk?.columns).toHaveLength(3);
  });
});

describe('レビューで直した境界（2026-09-30）', () => {
  it('列数を超える結合は読んでいる列の範囲に収める', () => {
    const cmp = compareWorkbooks(one([['a', 'b']]), book({ sheets: [{ name: 'a', rows: [['a', 'b']], merges: ['A1:XFD1'] }] }));
    const sheet = cmp.sheets[0];
    if (sheet === undefined) throw new Error('sheet');
    const g = buildGeometry(sheet);
    expect([...g.newMerges]).toEqual([0, 0, 0, g.colCount - 1]);
  });

  it('両側に空行が 1 つずつあっても、それを目印にして揃えない', () => {
    // 旧: x, (空), y / 新: y, (空), x。空行を目印にすると x と y が入れ替わったまま揃ってしまう
    const r = alignRows([1, 0, 2], [2, 0, 1], DEFAULT_LIMITS);
    const p = pairs(r.oldRow, r.newRow);
    expect(p.includes('1/1')).toBe(false);
  });

  it('表示文字は長すぎれば切り詰め、比較には影響しない', () => {
    const long = 'x'.repeat(5000);
    const cmp = compareWorkbooks(one([[long]]), one([[long]]));
    const sheet = cmp.sheets[0];
    if (sheet === undefined) throw new Error('sheet');
    expect(sheet.mark).toBe('same');
    const page = buildRowPage(cmp, sheet, 0, 1, 100);
    expect(page[0]?.new?.text[0]?.length).toBeLessThan(2100);
    expect(cellDetail(cmp, sheet, 0, 0).new?.display.length).toBe(5000);
  });

  it('予算をちょうど使い切っても、後続に変更のあるシートが無ければ「打ち切り」にしない', () => {
    const a = book({ sheets: [{ name: 's', rows: [[1], [2]] }, { name: 't', rows: [[1]] }] });
    const b = book({ sheets: [{ name: 's', rows: [[9], [8]] }, { name: 't', rows: [[1]] }] });
    const diff = buildRowDiff(compareWorkbooks(a, b), 0, { ...DEFAULT_LIMITS, maxRowDiffLines: 2 });
    expect(diff.truncated).toBe(false);
  });
});
