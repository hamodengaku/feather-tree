import { describe, expect, it } from 'vitest';
import {
  mergeXlsx,
  openWorkbook,
  openZip,
  readZipEntry,
  XlsxMergeError,
  type InflateResult,
  type OutRow,
  type Workbook,
  type XlsxSheetMerge,
} from '../src/index.js';
import { buildXlsx, type BookSpec } from './xlsxBuilder.js';

/*
 * ブックのセル単位の採用の組み立て（docs/07-xlsx-cell-merge.md）。
 * deflate / inflate は恒等写像（このパッケージのテストは Node を使えない。本物は core のテストで通す）。
 */

const inflate = (data: Uint8Array, max: number): InflateResult =>
  data.length > max ? { ok: false, reason: 'too-large' } : { ok: true, data };
const deflate = (d: Uint8Array): Uint8Array => d;

function open(bytes: Uint8Array): Workbook {
  const r = openWorkbook(bytes, inflate);
  if (!r.ok) throw new Error('open: ' + r.reason);
  return r.workbook;
}

function part(bytes: Uint8Array, name: string): string | null {
  const zip = openZip(bytes);
  if (!zip.ok) throw new Error('zip');
  const e = zip.archive.entries.get(name.toLowerCase());
  if (e === undefined) return null;
  const r = readZipEntry(zip.archive, e, inflate, 1 << 24);
  if (!r.ok) throw new Error(r.reason);
  return new TextDecoder().decode(r.data);
}

/** シートの値（数式があれば =式）を 2 次元配列で。 */
function grid(book: Workbook, sheet: string): string[][] {
  const data = book.sheets.find((s) => s.name === sheet)?.data;
  if (data == null) throw new Error('no sheet ' + sheet);
  const out: string[][] = [];
  for (let r = 0; r <= data.maxRow; r += 1) {
    const row: string[] = [];
    for (let c = 0; c <= data.maxCol; c += 1) {
      const cell = data.rows[r]?.cells.find((x) => x.col === c);
      if (cell === undefined) row.push('');
      else if (cell.formula !== null) row.push('=' + cell.formula);
      else if (cell.kind === 2) row.push(book.sst[cell.num] ?? '');
      else if (cell.kind === 1) row.push(String(cell.num));
      else row.push(cell.text ?? '');
    }
    out.push(row);
  }
  return out;
}

function ours(row: number, theirsRow = -1, theirsCols: number[] = []): OutRow {
  return { kind: 'ours', row, theirsRow, theirsCols: new Set(theirsCols) };
}
const theirs = (row: number): OutRow => ({ kind: 'theirs', row });

function plan(
  name: string,
  rows: OutRow[] | null,
  oursNewIndex: number[],
  oursTailShift: number,
  theirsNewIndex: number[],
  theirsTailShift = oursTailShift,
): XlsxSheetMerge {
  return {
    oursName: name,
    theirsName: name,
    rows,
    oursNewIndex: Int32Array.from(oursNewIndex),
    oursTailShift,
    theirsNewIndex: Int32Array.from(theirsNewIndex),
    theirsTailShift,
  };
}

function merge(o: BookSpec, t: BookSpec, sheets: XlsxSheetMerge[]): Uint8Array {
  const a = buildXlsx(o);
  const b = buildXlsx(t);
  return mergeXlsx({ ours: a, theirs: b, oursBook: open(a), theirsBook: open(b), sheets, inflate, deflate });
}

describe('セルの差し替え', () => {
  it('選んだセルだけ相手側になり、他は土台のまま。計算順序を消して再計算を立てる', () => {
    const o: BookSpec = {
      sheets: [{ name: 'S', rows: [['h', 'v'], ['a', 1], ['b', 2]] }],
      extraParts: [
        { name: 'xl/calcChain.xml', data: '<calcChain/>' },
        {
          name: 'xl/_rels/workbook.xml.rels',
          data:
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
            '<Relationship Id="rIdSst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
            '<Relationship Id="rIdCc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/>' +
            '</Relationships>',
        },
      ],
    };
    const t: BookSpec = { sheets: [{ name: 'S', rows: [['h', 'v'], ['a', 10], ['B!', 2]] }] };
    const out = merge(o, t, [plan('S', [ours(0), ours(1, 1, [1]), ours(2)], [0, 1, 2], 0, [0, 1, 2])]);
    expect(grid(open(out), 'S')).toEqual([['h', 'v'], ['a', '10'], ['b', '2']]);
    expect(part(out, 'xl/calcChain.xml')).toBeNull();
    expect(part(out, 'xl/_rels/workbook.xml.rels')).not.toContain('calcChain');
    expect(part(out, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"');
  });

  it('共有文字列はインライン文字列にし、リッチテキストの書式も写す', () => {
    const sst =
      '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">' +
      '<si><t>h</t></si><si><r><rPr><b/></rPr><t>太</t></r><r><t>字</t></r></si></sst>';
    const sheet =
      '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>';
    const o: BookSpec = { sheets: [{ name: 'S', rows: [['h', 'x']] }] };
    const t: BookSpec = {
      sheets: [{ name: 'S', xml: sheet }],
      extraParts: [{ name: 'xl/sharedStrings.xml', data: sst }],
    };
    const out = merge(o, t, [plan('S', [ours(0, 0, [1])], [0], 0, [0])]);
    expect(grid(open(out), 'S')).toEqual([['h', '太字']]);
    expect(part(out, 'xl/worksheets/sheet1.xml')).toContain('<is><r><rPr><b/></rPr><t>太</t></r><r><t>字</t></r></is>');
  });
});

describe('行の挿入・削除', () => {
  const oursBook: BookSpec = {
    sheets: [
      { name: 'S', rows: [[1, 'x'], [2], [3], [{ f: 'SUM(A1:A3)', v: 6 }, { f: 'A3*2', v: 6 }]], merges: ['B4:C4'] },
      { name: 'T', rows: [[{ f: 'S!A4+S!A3', v: 9 }]] },
    ],
  };

  it('相手側の行を途中に挿入すると、下の行・範囲・結合・他のシートの参照がずれる', () => {
    const theirsBook: BookSpec = {
      sheets: [
        { name: 'S', rows: [[1, 'x'], [2], [99], [3], [{ f: 'SUM(A1:A4)', v: 105 }, { f: 'A4*2', v: 6 }]] },
        { name: 'T', rows: [[{ f: 'S!A5+S!A4', v: 108 }]] },
      ],
    };
    const out = merge(oursBook, theirsBook, [
      plan('S', [ours(0), ours(1), theirs(2), ours(2), ours(3)], [0, 1, 3, 4], 1, [0, 1, 2, 3, 4], 1),
      plan('T', null, [0], 0, [0], 0),
    ]);
    const book = open(out);
    expect(grid(book, 'S')).toEqual([
      ['1', 'x'],
      ['2', ''],
      ['99', ''],
      ['3', ''],
      ['=SUM(A1:A4)', '=A4*2'],
    ]);
    expect(grid(book, 'T')).toEqual([['=S!A5+S!A4']]);
    expect(part(out, 'xl/worksheets/sheet1.xml')).toContain('<mergeCell ref="B5:C5"/>');
  });

  it('土台にしか無い行を削除すると、その行を指す参照は #REF!、範囲は縮む', () => {
    const theirsBook: BookSpec = {
      sheets: [
        { name: 'S', rows: [[1, 'x'], [2], [{ f: 'SUM(A1:A2)', v: 3 }, { f: '#REF!*2', v: 0 }]] },
        { name: 'T', rows: [[{ f: 'S!A3+#REF!', v: 0 }]] },
      ],
    };
    const out = merge(oursBook, theirsBook, [
      plan('S', [ours(0), ours(1), ours(3)], [0, 1, -1, 2], -1, [0, 1, 2], -1),
      plan('T', null, [0], 0, [0], 0),
    ]);
    const book = open(out);
    expect(grid(book, 'S')).toEqual([
      ['1', 'x'],
      ['2', ''],
      ['=SUM(A1:A2)', '=#REF!*2'],
    ]);
    expect(grid(book, 'T')).toEqual([['=S!A3+S!#REF!']]);
    expect(part(out, 'xl/worksheets/sheet1.xml')).toContain('<mergeCell ref="B3:C3"/>');
  });

  it('相手側の数式が、採らなかった行を指していれば断る', () => {
    const theirsBook: BookSpec = {
      sheets: [{ name: 'S', rows: [[1, 'x'], [2], [99], [3], [{ f: 'SUM(A1:A4)', v: 105 }, { f: 'A3', v: 99 }]] }, { name: 'T', rows: [[1]] }],
    };
    // 3 行目（99）は挿入しないが、5 行目の B 列（=A3）は相手側を採る
    expect(() =>
      merge(oursBook, theirsBook, [plan('S', [ours(0), ours(1), ours(2), ours(3, 4, [1])], [0, 1, 2, 3], 0, [0, 1, -1, 2, 3], 0)]),
    ).toThrow(XlsxMergeError);
  });

  it('行のずらし方が分からない部品を持つシートの行は動かさない', () => {
    const rels =
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable1.xml"/>' +
      '</Relationships>';
    const o: BookSpec = { ...oursBook, extraParts: [{ name: 'xl/worksheets/_rels/sheet1.xml.rels', data: rels }] };
    const theirsBook: BookSpec = { sheets: [{ name: 'S', rows: [[1, 'x'], [2], [99], [3]] }, { name: 'T', rows: [[1]] }] };
    expect(() =>
      merge(o, theirsBook, [plan('S', [ours(0), ours(1), theirs(2), ours(2), ours(3)], [0, 1, 3, 4], 1, [0, 1, 2, 3], 1)]),
    ).toThrow(/pivotTable/);
  });
});

describe('書式の持ち込み', () => {
  const styles = (fonts: string, xfs: string): string =>
    '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts>' +
    `<fonts count="${String(fonts.split('</font>').length - 1)}">${fonts}</fonts>` +
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${String(xfs.split('<xf ').length - 1)}">${xfs}</cellXfs></styleSheet>`;
  const sheet = (cell: string): string =>
    '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    `<row r="1">${cell}</row></sheetData></worksheet>`;

  it('相手側の書式を土台の styles.xml へ足し、ユーザー定義の表示形式も持ち込む', () => {
    const o: BookSpec = {
      sheets: [{ name: 'S', xml: sheet('<c r="A1"><v>1</v></c>') }],
      extraParts: [
        { name: 'xl/styles.xml', data: styles('<font><sz val="11"/></font>', '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>') },
      ],
    };
    const t: BookSpec = {
      sheets: [{ name: 'S', xml: sheet('<c r="A1" s="1"><v>2</v></c>') }],
      extraParts: [
        {
          name: 'xl/styles.xml',
          data: styles(
            '<font><sz val="11"/></font><font><b/><sz val="14"/></font>',
            '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
          ),
        },
      ],
    };
    // 土台に styles.xml の関係が無いので、既定のパス（xl/styles.xml）で読み書きする
    const out = merge(o, t, [plan('S', [ours(0, 0, [0])], [0], 0, [0])]);
    const book = open(out);
    const cell = book.sheets[0]?.data?.rows[0]?.cells[0];
    expect(cell?.num).toBe(2);
    const style = book.styles?.cells[cell?.style ?? 0];
    expect(style?.bold).toBe(true);
    expect(style?.sizePt).toBe(14);
    expect(style?.numFmtCode).toBe('0.000');
    const xml = part(out, 'xl/styles.xml') ?? '';
    expect(xml).toContain('<fonts count="2">');
    expect(xml).toContain('<cellXfs count="2">');
  });
});
