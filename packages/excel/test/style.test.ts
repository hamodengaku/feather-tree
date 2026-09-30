import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  applyTint,
  buildGeometry,
  compareWorkbooks,
  normalizeRgb,
  openWorkbook,
  parseStyles,
  parseTheme,
  resolveColor,
  themeSlot,
  type Workbook,
} from '../src/index.js';
import { buildXlsx, type BookSpec } from './xlsxBuilder.js';
import { identityInflater } from './zipBuilder.js';

/*
 * 書式（決定 33 の M2）: 色の解決・テーマ・styles.xml・行と列の書式。
 */

/** #rrggbb の各色が ±tolerance に収まるか。 */
function near(actual: string | null, expected: string, tolerance = 3): boolean {
  if (actual === null) return false;
  for (let i = 1; i < 7; i += 2) {
    const a = Number.parseInt(actual.slice(i, i + 2), 16);
    const e = Number.parseInt(expected.slice(i, i + 2), 16);
    if (Math.abs(a - e) > tolerance) return false;
  }
  return true;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.0&quot;円&quot;"/></numFmts>
  <fonts count="3">
    <font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
    <font><b/><i/><u/><sz val="14"/><color rgb="FFFF0000"/><name val="Calibri"/></font>
    <font><strike/><sz val="11"/><color theme="4" tint="-0.249977111117893"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor theme="4" tint="0.5999938962981048"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor indexed="5"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color indexed="64"/></left><right style="medium"><color rgb="FF00FF00"/></right><top/><bottom style="double"/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="164" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1"><alignment horizontal="center" vertical="top" wrapText="1" indent="2"/></xf>
    <xf numFmtId="14" fontId="2" fillId="3" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="1" borderId="0" xfId="0"><alignment horizontal="bogus"/></xf>
  </cellXfs>
  <dxfs count="1"><dxf><font><b/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs>
</styleSheet>`;

const THEME = `<?xml version="1.0" encoding="UTF-8"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
  <a:themeElements><a:clrScheme name="Office">
    <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
    <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
    <a:dk2><a:srgbClr val="44546A"/></a:dk2>
    <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
    <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
    <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
    <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
    <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
    <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
    <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
    <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
    <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
  </a:clrScheme></a:themeElements>
</a:theme>`;

describe('色の解決', () => {
  it('ARGB と RGB を #rrggbb に。形が違えば null', () => {
    expect(normalizeRgb('FF4472C4')).toBe('#4472c4');
    expect(normalizeRgb('4472c4')).toBe('#4472c4');
    expect(normalizeRgb('red')).toBeNull();
    expect(normalizeRgb('FF44;72C')).toBeNull();
  });

  it('テーマ番号の最初の 2 組は入れ替わる（0 = lt1, 1 = dk1）', () => {
    expect([0, 1, 2, 3, 4].map(themeSlot)).toEqual([1, 0, 3, 2, 4]);
    const theme = parseTheme(new TextEncoder().encode(THEME));
    expect(resolveColor({ rgb: null, theme: 0, tint: 0, indexed: null, auto: false }, theme, [])).toBe('#ffffff');
    expect(resolveColor({ rgb: null, theme: 1, tint: 0, indexed: null, auto: false }, theme, [])).toBe('#000000');
  });

  it('tint は Office のパレットと同じ色になる（accent1 の明るく 40% / 60%、暗く 25%）', () => {
    expect(near(applyTint('#4472c4', 0.3999755851924192), '#8eaadb')).toBe(true);
    expect(near(applyTint('#4472c4', 0.5999938962981048), '#b4c6e7')).toBe(true);
    expect(near(applyTint('#4472c4', -0.249977111117893), '#2f5496')).toBe(true);
    expect(applyTint('#000000', 0.5)).toBe('#808080');
  });

  it('indexed と auto', () => {
    expect(resolveColor({ rgb: null, theme: null, tint: 0, indexed: 2, auto: false }, DEFAULT_THEME, [])).toBe('#ff0000');
    expect(resolveColor({ rgb: 'FF123456', theme: null, tint: 0, indexed: null, auto: true }, DEFAULT_THEME, [])).toBeNull();
  });

  it('テーマの部品が壊れていても既定の色で埋める', () => {
    expect(parseTheme(new TextEncoder().encode('<a:theme><a:clrScheme><a:dk1>'))).toEqual([...DEFAULT_THEME]);
  });
});

describe('styles.xml', () => {
  const table = parseStyles(new TextEncoder().encode(STYLES), parseTheme(new TextEncoder().encode(THEME)));

  it('cellXfs の 1 件ずつを解決済みの書式にする', () => {
    expect(table.cells).toHaveLength(4);
    const plain = table.cells[0];
    expect(plain?.bold).toBe(false);
    expect(plain?.fill).toBeNull();
    expect(plain?.color).toBe('#000000');

    const fancy = table.cells[1];
    expect(fancy?.bold && fancy.italic && fancy.underline).toBe(true);
    expect(fancy?.sizePt).toBe(14);
    expect(fancy?.color).toBe('#ff0000');
    expect(near(fancy?.fill ?? null, '#b4c6e7')).toBe(true);
    expect(fancy?.borderLeft).toEqual({ style: 'thin', color: '#000000' });
    expect(fancy?.borderRight).toEqual({ style: 'medium', color: '#00ff00' });
    expect(fancy?.borderTop).toBeNull();
    expect(fancy?.borderBottom).toEqual({ style: 'double', color: null });
    expect(fancy?.horizontal).toBe('center');
    expect(fancy?.vertical).toBe('top');
    expect(fancy?.wrap).toBe(true);
    expect(fancy?.indent).toBe(2);
    expect(fancy?.numFmtCode).toBe('#,##0.0"円"');
  });

  it('取り消し線・テーマ色の tint・indexed の塗り・組み込みの表示形式', () => {
    const cell = table.cells[2];
    expect(cell?.strike).toBe(true);
    expect(near(cell?.color ?? null, '#2f5496')).toBe(true);
    expect(cell?.fill).toBe('#ffff00');
    expect(cell?.numFmtId).toBe(14);
    expect(cell?.numFmtCode).toBeNull();
  });

  it('gray125 は塗りとみなさない。知らない配置は捨てる。dxfs（条件付き書式）は読まない', () => {
    expect(table.cells[3]?.fill).toBeNull();
    expect(table.cells[3]?.horizontal).toBeNull();
    expect(table.defaultSizePt).toBe(11);
  });

  it('壊れた styles.xml でも例外を投げない', () => {
    for (const bad of ['<styleSheet><fonts><font><b', '<styleSheet><cellXfs><xf fontId="99"/></cellXfs></styleSheet>', '']) {
      expect(() => parseStyles(new TextEncoder().encode(bad), DEFAULT_THEME)).not.toThrow();
    }
    const orphan = parseStyles(new TextEncoder().encode('<styleSheet><cellXfs><xf fontId="99" fillId="7" borderId="3"/></cellXfs></styleSheet>'), DEFAULT_THEME);
    expect(orphan.cells[0]?.fill).toBeNull();
    expect(orphan.cells[0]?.borderLeft).toBeNull();
  });
});

describe('ブックの書式', () => {
  function book(spec: BookSpec): Workbook {
    const r = openWorkbook(buildXlsx(spec), identityInflater);
    if (!r.ok) throw new Error('open failed: ' + r.reason);
    return r.workbook;
  }

  it('styles.xml と theme1.xml を読み、行（customFormat）と列の書式を持つ', () => {
    const xml =
      '<worksheet><cols><col min="2" max="2" width="10" style="2"/></cols><sheetData>' +
      '<row r="1" s="1" customFormat="1"><c r="A1" s="3"><v>1</v></c></row>' +
      '<row r="2" s="1"><c r="A2"><v>2</v></c></row>' +
      '</sheetData></worksheet>';
    const wb = book({
      sheets: [{ name: 'a', xml }],
      extraParts: [
        { name: 'xl/styles.xml', data: STYLES },
        { name: 'xl/theme/theme1.xml', data: THEME },
      ],
    });
    expect(wb.styles?.cells).toHaveLength(4);
    const data = wb.sheets[0]?.data;
    expect(data?.rows[0]?.style).toBe(1);
    // customFormat が無ければ行の書式は効かない
    expect(data?.rows[1]?.style).toBe(-1);
    expect(data?.cols[0]?.style).toBe(2);
    expect(data?.rows[0]?.cells[0]?.style).toBe(3);

    const sheet = compareWorkbooks(wb, wb).sheets[0];
    if (sheet === undefined) throw new Error('sheet');
    const g = buildGeometry(sheet);
    expect([...g.newRowStyle]).toEqual([1, -1]);
    expect([...g.oldColStyle]).toEqual([-1]);
  });

  it('styles.xml が無いブックは styles が null（既定の見た目）', () => {
    expect(book({ sheets: [{ name: 'a', rows: [[1]] }] }).styles).toBeNull();
  });
});
