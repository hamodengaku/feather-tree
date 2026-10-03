import { describe, expect, it } from 'vitest';
import {
  CELL_INLINE,
  CSV_SHEET_NAME,
  DEFAULT_LIMITS,
  compareWorkbooks,
  csvRecords,
  decodeCsv,
  isCsvPath,
  openCsv,
  type OpenResult,
  type Workbook,
} from '../src/index.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function bookOf(result: OpenResult): Workbook {
  if (!result.ok) throw new Error('open failed: ' + result.reason);
  return result.workbook;
}

/** シート 1 枚の値を 2 次元配列で（空セルは ''）。 */
function grid(book: Workbook): string[][] {
  const data = book.sheets[0]?.data;
  if (data == null) return [];
  const out: string[][] = [];
  for (let r = 0; r <= data.maxRow; r += 1) {
    const row: string[] = [];
    for (let c = 0; c <= data.maxCol; c += 1) {
      row.push(data.rows[r]?.cells.find((cell) => cell.col === c)?.text ?? '');
    }
    out.push(row);
  }
  return out;
}

describe('CSV のレコード分割（RFC 4180）', () => {
  it('引用符の中のカンマ・改行・二重引用符を値として扱う', () => {
    const text = 'id,name,memo\r\n1,"Smith, John","line1\nline2"\r\n2,"say ""hi""",\r\n';
    expect([...csvRecords(text)]).toEqual([
      ['id', 'name', 'memo'],
      ['1', 'Smith, John', 'line1\nline2'],
      ['2', 'say "hi"', ''],
    ]);
  });

  it('LF・CR だけの改行でも区切る。末尾に改行が無くても最後の行を読む', () => {
    expect([...csvRecords('a,b\nc,d\re,f')]).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('閉じていない引用符でも落ちず、残りを値にする', () => {
    expect([...csvRecords('a,"bc\nd')]).toEqual([['a', 'bc\nd']]);
  });
});

describe('文字コード', () => {
  it('UTF-8（BOM あり・なし）', () => {
    expect(decodeCsv(encode('名前,値'))).toEqual({ text: '名前,値', encoding: 'utf-8' });
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encode('名前')]);
    expect(decodeCsv(bom)).toEqual({ text: '名前', encoding: 'utf-8' });
  });

  it('UTF-8 として読めなければ Shift_JIS（日本語版 Excel の既定）', () => {
    // 「名前,値」の Shift_JIS
    const sjis = new Uint8Array([0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x92, 0x6c]);
    expect(decodeCsv(sjis)).toEqual({ text: '名前,値', encoding: 'shift_jis' });
  });

  it('UTF-16LE（BOM）', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x2c, 0x00, 0x42, 0x00]);
    expect(decodeCsv(utf16)).toEqual({ text: 'A,B', encoding: 'utf-16le' });
  });

  it('NUL を含む（バイナリ）なら読まない', () => {
    expect(decodeCsv(new Uint8Array([0x61, 0x00, 0x62]))).toBeNull();
  });
});

describe('CSV をブックのモデルで開く', () => {
  it('シート 1 枚・値はすべて文字列のまま（0001 や 1.0 を数値に直さない）', () => {
    const book = bookOf(openCsv(encode('code,price\n0001,1.0\n')));
    expect(book.sheets).toHaveLength(1);
    expect(book.sheets[0]?.name).toBe(CSV_SHEET_NAME);
    expect(book.styles).toBeNull();
    expect(grid(book)).toEqual([
      ['code', 'price'],
      ['0001', '1.0'],
    ]);
    expect(book.sheets[0]?.data?.rows[1]?.cells.every((c) => c.kind === CELL_INLINE)).toBe(true);
  });

  it('空の値はセルを作らず、末尾の空行は行に数えない', () => {
    const book = bookOf(openCsv(encode('a,,c\n\n\n')));
    const data = book.sheets[0]?.data;
    expect(data?.maxRow).toBe(0);
    expect(data?.rows[0]?.cells.map((c) => c.col)).toEqual([0, 2]);
  });

  it('空・LFS ポインタ・ZIP・バイナリは開かずに理由を返す', () => {
    expect(openCsv(new Uint8Array(0))).toEqual({ ok: false, reason: 'empty' });
    expect(openCsv(encode('version https://git-lfs.github.com/spec/v1\noid sha256:x\n'))).toEqual({
      ok: false,
      reason: 'lfs-pointer',
    });
    expect(openCsv(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toEqual({ ok: false, reason: 'not-spreadsheet' });
    expect(openCsv(new Uint8Array([0x61, 0x00, 0x62]))).toEqual({ ok: false, reason: 'not-spreadsheet' });
  });

  it('列の上限より右は捨てて印を立て、行の上限で打ち切る', () => {
    const limits = { ...DEFAULT_LIMITS, maxColumns: 2, maxRowsPerSheet: 2 };
    const book = bookOf(openCsv(encode('a,b,c\nd,e,f\ng,h,i\n'), limits));
    const data = book.sheets[0]?.data;
    expect(data?.columnsTruncated).toBe(true);
    expect(data?.problem).toBe('too-large');
    expect(grid(book)).toEqual([
      ['a', 'b'],
      ['d', 'e'],
    ]);
  });

  it('新旧を比べると、変わった行だけが差分になる（比較は手を入れずに使える）', () => {
    const before = bookOf(openCsv(encode('id,name\n1,apple\n2,banana\n')));
    const after = bookOf(openCsv(encode('id,name\n1,apple\n2,BANANA\n3,cherry\n')));
    const result = compareWorkbooks(before, after);
    const sheet = result.sheets[0];
    expect(sheet?.mark).toBe('changed');
    expect(sheet?.renamed).toBe(false);
  });

  it('拡張子の判定は大文字小文字を区別しない', () => {
    expect(isCsvPath('data/Items.CSV')).toBe(true);
    expect(isCsvPath('data/items.csv.bak')).toBe(false);
  });
});
