import { describe, expect, it } from 'vitest';
import {
  CELL_BOOL,
  CELL_ERROR,
  CELL_FORMULA_STR,
  CELL_INLINE,
  CELL_NUMBER,
  CELL_SHARED,
  DEFAULT_LIMITS,
  FORMULA_ARRAY,
  FORMULA_SHARED,
  displayText,
  openWorkbook,
  type OpenResult,
  type SheetData,
  type Workbook,
} from '../src/index.js';
import { buildXlsx, type BookSpec } from './xlsxBuilder.js';
import { buildZip, identityInflater } from './zipBuilder.js';

function open(spec: BookSpec, limits = DEFAULT_LIMITS): OpenResult {
  return openWorkbook(buildXlsx(spec), identityInflater, limits);
}

function book(spec: BookSpec): Workbook {
  const r = open(spec);
  if (!r.ok) throw new Error('open failed: ' + r.reason);
  return r.workbook;
}

function sheet(wb: Workbook, i = 0): SheetData {
  const data = wb.sheets[i]?.data;
  if (data == null) throw new Error('no data');
  return data;
}

/** シートの値を表示文字の 2 次元配列にする（空のセルは ''）。 */
function grid(wb: Workbook, i = 0): string[][] {
  const data = sheet(wb, i);
  const out: string[][] = [];
  for (let r = 0; r <= data.maxRow; r += 1) {
    const row: string[] = [];
    for (let c = 0; c <= data.maxCol; c += 1) {
      const cell = data.rows[r]?.cells.find((x) => x.col === c);
      row.push(displayText(cell, wb.sst));
    }
    out.push(row);
  }
  return out;
}

describe('ブックを開く（決定 33）', () => {
  it('シート・共有文字列・数値・真偽・エラー・インライン文字列を読む', () => {
    const wb = book({
      sheets: [
        { name: '売上', rows: [['品名', '単価', '在庫'], ['剣', 1200, true], ['盾', { error: '#N/A' }, { inline: '直書き' }]] },
        { name: 'Sheet2', rows: [[1]] },
      ],
    });
    expect(wb.sheets.map((s) => s.name)).toEqual(['売上', 'Sheet2']);
    expect(grid(wb)).toEqual([
      ['品名', '単価', '在庫'],
      ['剣', '1200', 'TRUE'],
      ['盾', '#N/A', '直書き'],
    ]);
    const cells = sheet(wb).rows[1]?.cells ?? [];
    expect(cells.map((c) => c.kind)).toEqual([CELL_SHARED, CELL_NUMBER, CELL_BOOL]);
    expect(sheet(wb).rows[2]?.cells.map((c) => c.kind)).toEqual([CELL_SHARED, CELL_ERROR, CELL_INLINE]);
  });

  it('共有文字列のリッチテキストは連結し、ふりがな（rPh）は混ぜない', () => {
    const sst =
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<si><r><rPr><b/></rPr><t>東</t></r><r><t>京</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/></si>' +
      '<si><t>改行_x000D_あり</t></si>' +
      '</sst>';
    const wb = book({
      sheets: [{ name: 'a', xml: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>' }],
      extraParts: [{ name: 'xl/sharedStrings.xml', data: sst }],
    });
    expect(grid(wb)).toEqual([['東京', '改行\rあり']]);
  });

  it('数式と、その文字列の結果（t="str"）', () => {
    const wb = book({ sheets: [{ name: 'a', rows: [[2, { f: 'A1*3', v: 6 }, { f: 'TEXT(A1,"0")', v: '2' }]] }] });
    const cells = sheet(wb).rows[0]?.cells ?? [];
    expect(cells[1]?.formula).toBe('A1*3');
    expect(cells[1]?.num).toBe(6);
    expect(cells[2]?.kind).toBe(CELL_FORMULA_STR);
    expect(cells[2]?.text).toBe('2');
  });

  it('共有数式の従属セルは、先頭の式を位置の差だけずらして持つ', () => {
    const wb = book({
      sheets: [
        {
          name: 'a',
          rows: [
            [1, { f: 'A1*2', v: 2, t: 'shared', si: 0, ref: 'B1:B3' }],
            [2, { fs: 0 }],
            [3, { fs: 0 }],
          ],
        },
      ],
    });
    const formulas = [0, 1, 2].map((r) => sheet(wb).rows[r]?.cells[1]?.formula);
    expect(formulas).toEqual(['A1*2', 'A2*2', 'A3*2']);
    expect(sheet(wb).rows[1]?.cells[1]?.formulaKind).toBe(FORMULA_SHARED);
  });

  it('配列数式は先頭のセルだけが式を持つ', () => {
    const wb = book({ sheets: [{ name: 'a', rows: [[{ f: 'SUM(B1:B2*C1:C2)', v: 5, t: 'array', ref: 'A1' }]] }] });
    const cell = sheet(wb).rows[0]?.cells[0];
    expect(cell?.formulaKind).toBe(FORMULA_ARRAY);
    expect(cell?.formula).toBe('SUM(B1:B2*C1:C2)');
  });

  it('r の省略・順序の乱れ・接頭辞付きの要素（strict や他のツール）', () => {
    const xml =
      '<x:worksheet xmlns:x="http://purl.oclc.org/ooxml/spreadsheetml/main"><x:sheetData>' +
      '<x:row><x:c><x:v>1</x:v></x:c><x:c><x:v>2</x:v></x:c></x:row>' +
      '<x:row r="3"><x:c r="C3"><x:v>9</x:v></x:c><x:c r="A3"><x:v>7</x:v></x:c></x:row>' +
      '</x:sheetData></x:worksheet>';
    const wb = book({ sheets: [{ name: 'a', xml }] });
    expect(grid(wb)).toEqual([
      ['1', '2', ''],
      ['', '', ''],
      ['7', '', '9'],
    ]);
  });

  it('結合・非表示の行・行の高さ・列幅・窓枠の固定', () => {
    const wb = book({
      sheets: [
        {
          name: 'a',
          rows: [['a', 'b'], ['c', 'd'], ['e', 'f']],
          merges: ['A1:B1'],
          hiddenRows: [1],
          rowHeights: { 2: 30 },
          cols: '<sheetViews><sheetView><pane xSplit="1" ySplit="2" state="frozen"/></sheetView></sheetViews><cols><col min="2" max="3" width="20.7109375" customWidth="1" hidden="1"/></cols>',
        },
      ],
    });
    const data = sheet(wb);
    expect([...data.merges]).toEqual([0, 0, 0, 1]);
    expect(data.rows[1]?.hidden).toBe(true);
    expect(data.rows[2]?.heightPt).toBe(30);
    expect(data.cols).toEqual([{ min: 1, max: 2, widthPx: 145, hidden: true, style: -1 }]);
    expect(data.frozen).toEqual({ rows: 2, cols: 1 });
    expect(data.defaultColWidthPx).toBe(64);
  });

  it('値の無い書式だけのセルは残し、書式も値も無いセルは捨てる', () => {
    const wb = book({
      sheets: [{ name: 'a', xml: '<worksheet><sheetData><row r="1"><c r="A1"/><c r="B1" s="3"/></row></sheetData></worksheet>' }],
    });
    expect(sheet(wb).rows[0]?.cells.map((c) => c.col)).toEqual([1]);
  });

  it('非表示シート・グラフシート・1904 年起点・マクロ', () => {
    const wb = book({
      sheets: [{ name: 'a', state: 'hidden', rows: [[1]] }, { name: 'グラフ', chart: true }],
      date1904: true,
      vba: 'macro',
    });
    expect(wb.sheets[0]?.state).toBe('hidden');
    expect(wb.sheets[1]?.kind).toBe('chartsheet');
    expect(wb.sheets[1]?.data).toBeNull();
    expect(wb.date1904).toBe(true);
    expect(wb.vbaCrc).not.toBeNull();
  });

  it('共有文字列の部品が無くても開ける', () => {
    const wb = book({ sheets: [{ name: 'a', rows: [[1, 2]] }], omit: ['xl/sharedStrings.xml'] });
    expect(grid(wb)).toEqual([['1', '2']]);
  });

  it('シートの部品が欠けていれば、そのシートだけ missing-part', () => {
    const wb = book({ sheets: [{ name: 'a', rows: [[1]] }, { name: 'b', rows: [[2]] }], omit: ['xl/worksheets/sheet2.xml'] });
    expect(wb.sheets[0]?.problem).toBeNull();
    expect(wb.sheets[1]?.problem).toBe('missing-part');
  });
});

describe('開けないもの（決定 33）', () => {
  it('CFB（旧形式・パスワード付き）・LFS ポインタ・空・ZIP でないもの', () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(openWorkbook(cfb, identityInflater)).toEqual({ ok: false, reason: 'encrypted-or-legacy' });
    const lfs = new TextEncoder().encode('version https://git-lfs.github.com/spec/v1\noid sha256:0\nsize 1\n');
    expect(openWorkbook(lfs, identityInflater)).toEqual({ ok: false, reason: 'lfs-pointer' });
    expect(openWorkbook(new Uint8Array(0), identityInflater)).toEqual({ ok: false, reason: 'empty' });
    expect(openWorkbook(new TextEncoder().encode('hello'), identityInflater)).toEqual({ ok: false, reason: 'not-zip' });
  });

  it('.xlsb（ブック本体が .bin）はスプレッドシートとして読まない', () => {
    const zip = buildZip([
      {
        name: '_rels/.rels',
        data: '<Relationships><Relationship Id="r" Type="x/officeDocument" Target="xl/workbook.bin"/></Relationships>',
      },
      { name: 'xl/workbook.bin', data: 'binary' },
    ]);
    expect(openWorkbook(zip, identityInflater)).toEqual({ ok: false, reason: 'not-spreadsheet' });
  });

  it('ブック本体の無い ZIP は not-spreadsheet', () => {
    expect(openWorkbook(buildZip([{ name: 'a.txt', data: 'x' }]), identityInflater)).toEqual({
      ok: false,
      reason: 'not-spreadsheet',
    });
  });

  it('ファイルの上限・セルの上限', () => {
    const spec: BookSpec = { sheets: [{ name: 'a', rows: [[1, 2, 3], [4, 5, 6]] }, { name: 'b', rows: [[7]] }] };
    expect(open(spec, { ...DEFAULT_LIMITS, maxFileBytes: 10 })).toEqual({ ok: false, reason: 'too-large' });

    const bySheet = open(spec, { ...DEFAULT_LIMITS, maxCellsPerSheet: 4 });
    if (!bySheet.ok) throw new Error('open');
    expect(bySheet.workbook.sheets[0]?.problem).toBe('too-large');
    expect(bySheet.workbook.sheets[0]?.data?.cellCount).toBe(4);
    expect(bySheet.workbook.sheets[1]?.problem).toBeNull();

    const byBook = open(spec, { ...DEFAULT_LIMITS, maxCellsPerBook: 6 });
    if (!byBook.ok) throw new Error('open');
    expect(byBook.workbook.sheets[1]?.problem).toBe('too-large');
    expect(byBook.workbook.sheets[1]?.data).toBeNull();
  });

  it('列の上限より右は捨てて印を立てる', () => {
    const r = open({ sheets: [{ name: 'a', rows: [[1, 2, 3, 4]] }] }, { ...DEFAULT_LIMITS, maxColumns: 2 });
    if (!r.ok) throw new Error('open');
    const data = r.workbook.sheets[0]?.data;
    expect(data?.rows[0]?.cells.map((c) => c.col)).toEqual([0, 1]);
    expect(data?.columnsTruncated).toBe(true);
  });

  it('展開の合計予算を超えたら too-large', () => {
    const spec: BookSpec = { sheets: [{ name: 'a', rows: [['x'.repeat(2000)]] }] };
    expect(open(spec, { ...DEFAULT_LIMITS, maxTotalBytes: 1500 })).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('レビューで直した境界（2026-09-30）', () => {
  it('& を大量に並べた文字列でも一瞬で終わる（; を 12 文字先までしか探さない）', () => {
    const text = '&'.repeat(200_000);
    const started = Date.now();
    const wb = book({
      sheets: [{ name: 'a', xml: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData></worksheet>` }],
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(sheet(wb).rows[0]?.cells[0]?.text?.length).toBe(200_000);
  });

  it('ちょうど上限の個数のセルは読み切れる（打ち切りは上限を超える 1 個目）', () => {
    const r = open({ sheets: [{ name: 'a', rows: [[1, 2, 3, 4]] }, { name: 'b', rows: [[5]] }] }, { ...DEFAULT_LIMITS, maxCellsPerSheet: 4 });
    if (!r.ok) throw new Error('open');
    expect(r.workbook.sheets[0]?.problem).toBeNull();
    expect(r.workbook.sheets[0]?.data?.cellCount).toBe(4);
  });

  it('r の無い空の行を並べても、行数の上限で打ち切る', () => {
    const xml = '<worksheet><sheetData>' + '<row/>'.repeat(50) + '</sheetData></worksheet>';
    const r = open({ sheets: [{ name: 'a', xml }] }, { ...DEFAULT_LIMITS, maxRowsPerSheet: 10 });
    if (!r.ok) throw new Error('open');
    expect(r.workbook.sheets[0]?.problem).toBe('too-large');
    expect(r.workbook.sheets[0]?.data?.rows.length).toBe(10);
  });

  it('共有文字列の件数にも上限がある', () => {
    const r = open({ sheets: [{ name: 'a', rows: [['a', 'b', 'c']] }] }, { ...DEFAULT_LIMITS, maxSharedStrings: 2 });
    if (!r.ok) throw new Error('open');
    expect(r.workbook.sst).toEqual(['a', 'b']);
  });
});
