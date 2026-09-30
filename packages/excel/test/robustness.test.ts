import { describe, expect, it } from 'vitest';
import { buildGeometry, buildRowDiff, buildRowPage, cellDetail, compareWorkbooks, openWorkbook } from '../src/index.js';
import { buildXlsx } from './xlsxBuilder.js';
import { identityInflater } from './zipBuilder.js';

/*
 * 壊れた入力で例外を投げないこと（決定 33 / 要件 E7）。
 *
 * 正しい xlsx を固定シードの乱数で壊し（バイトの書き換え・切り詰め・挿入）、開く → 比べる →
 * 幾何・ページ・行単位比較まで通して、どれも投げないことを確かめる。テスト用の ZIP は無圧縮なので、
 * 壊したバイトは XML の中身にも当たる。
 */

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const base = buildXlsx({
  sheets: [
    {
      name: '売上',
      rows: [
        ['品名', '単価', '数量', '小計'],
        ['剣', 1000, 3, { f: 'B2*C2', v: 3000, t: 'shared', si: 0, ref: 'D2:D4' }],
        ['盾', 800, 5, { fs: 0 }],
        ['弓', 600, 2, { fs: 0 }],
        [{ error: '#N/A' }, true, { inline: 'x' }, { f: 'SUM(D2:D4)', v: 7200 }],
      ],
      merges: ['A6:D6'],
      hiddenRows: [2],
      cols: '<cols><col min="1" max="1" width="20"/></cols>',
    },
    { name: 'メモ', rows: [['a'], ['b']] },
    {
      name: '書式',
      xml:
        '<worksheet><cols><col min="1" max="3" width="12" style="1"/></cols><sheetData>' +
        '<row r="1" s="2" customFormat="1"><c r="A1" s="1"><v>45366.5</v></c><c r="B1" s="2"><v>-1234.5</v></c>' +
        '<c r="C1" s="3"><v>3.14159</v></c><c r="D1" s="1" t="d"><v>2024-03-15T12:00:00</v></c></row>' +
        '</sheetData></worksheet>',
    },
  ],
  // 書式（M2）と表示形式（M3）も壊される対象に入れる
  extraParts: [
    {
      name: 'xl/styles.xml',
      data:
        '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="[$-411]ggge&quot;年&quot;m&quot;月&quot;d&quot;日&quot;;#,##0.00;[Red]\\-0"/></numFmts>' +
        '<fonts><font><sz val="11"/></font><font><b/><color theme="4" tint="0.4"/></font></fonts>' +
        '<fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
        '<fill><patternFill patternType="solid"><fgColor indexed="5"/></patternFill></fill></fills>' +
        '<borders><border/><border><left style="thin"><color rgb="FF000000"/></left></border></borders>' +
        '<cellXfs><xf/><xf numFmtId="164" fontId="1" fillId="2" borderId="1"><alignment horizontal="center" wrapText="1"/></xf>' +
        '<xf numFmtId="14"/><xf numFmtId="12"/></cellXfs></styleSheet>',
    },
  ],
});

function exercise(bytes: Uint8Array): void {
  const r = openWorkbook(bytes, identityInflater);
  const good = openWorkbook(base, identityInflater);
  if (!good.ok) throw new Error('base');
  const cmp = compareWorkbooks(good.workbook, r.ok ? r.workbook : null);
  for (const sheet of cmp.sheets) {
    const g = buildGeometry(sheet);
    buildRowPage(cmp, sheet, 0, g.rowCount + 2, 100);
    for (let row = 0; row < Math.min(g.rowCount, 3); row += 1) cellDetail(cmp, sheet, row, 0);
  }
  buildRowDiff(cmp, 3);
}

describe('壊れた入力（要件 E7）', () => {
  it('もとのファイルは開ける', () => {
    expect(openWorkbook(base, identityInflater).ok).toBe(true);
  });

  it('固定シードで 1,000 通りに壊しても例外を投げない', () => {
    const rand = lcg(20260930);
    for (let n = 0; n < 1000; n += 1) {
      const bytes = base.slice();
      const kind = n % 3;
      if (kind === 0) {
        const flips = 1 + Math.floor(rand() * 8);
        for (let i = 0; i < flips; i += 1) bytes[Math.floor(rand() * bytes.length)] = Math.floor(rand() * 256);
        expect(() => exercise(bytes), `flip #${String(n)}`).not.toThrow();
      } else if (kind === 1) {
        const cut = Math.floor(rand() * bytes.length);
        expect(() => exercise(bytes.subarray(0, cut)), `cut #${String(n)}`).not.toThrow();
      } else {
        const at = Math.floor(rand() * bytes.length);
        const junk = Uint8Array.from({ length: 1 + Math.floor(rand() * 16) }, () => Math.floor(rand() * 256));
        const grown = new Uint8Array(bytes.length + junk.length);
        grown.set(bytes.subarray(0, at), 0);
        grown.set(junk, at);
        grown.set(bytes.subarray(at), at + junk.length);
        expect(() => exercise(grown), `insert #${String(n)}`).not.toThrow();
      }
    }
  });

  it('XML の特殊な文字列（閉じない要素・巨大な属性・深い入れ子）でも投げない', () => {
    const nasty = [
      '<worksheet><sheetData><row r="1"><c r="A1"><v>1',
      '<worksheet><sheetData><row r="99999999"><c r="ZZZZ1"><v>x</v></c></row></sheetData></worksheet>',
      '<worksheet><sheetData>' + '<row>'.repeat(2000) + '</sheetData></worksheet>',
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>999999</v></c><c r="B1" t="s"><v>-1</v></c></row></sheetData></worksheet>',
      '<worksheet><mergeCells><mergeCell ref="A1:"/><mergeCell ref=":B2"/><mergeCell ref="XFE1:A1"/></mergeCells></worksheet>',
      '<worksheet><cols><col min="0" max="-1" width="NaN"/><col min="5" max="2"/></cols></worksheet>',
    ];
    for (const xml of nasty) {
      const bytes = buildXlsx({ sheets: [{ name: 'a', xml }] });
      expect(() => exercise(bytes), xml.slice(0, 60)).not.toThrow();
    }
  });
});
