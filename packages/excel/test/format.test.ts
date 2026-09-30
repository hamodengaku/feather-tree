import { describe, expect, it } from 'vitest';
import {
  builtinFormat,
  eraOf,
  formatContextOf,
  formatNumber,
  formatTextValue,
  formattedText,
  isDateFormat,
  isoToSerial,
  openWorkbook,
  serialToParts,
} from '../src/index.js';
import { buildXlsx } from './xlsxBuilder.js';
import { identityInflater } from './zipBuilder.js';

/*
 * 表示形式（決定 33 の M3）。期待値は日本語版 Excel の表示に合わせてある。
 */

const f = (v: number, code: string, date1904 = false): string | null => formatNumber(v, code, date1904);

describe('数値', () => {
  it.each([
    [1234.5, '0', '1235'],
    [1234.5, '0.00', '1234.50'],
    [1234567.891, '#,##0', '1,234,568'],
    [1234567.891, '#,##0.00', '1,234,567.89'],
    [0.5, '#.##', '.5'],
    [5, '#.##', '5.'],
    [0, '0.0', '0.0'],
    [0.1 + 0.2, '0.0000000000', '0.3000000000'],
    [7, '000', '007'],
    [1.5, '?.??', '1.5 '],
    [0.256, '0%', '26%'],
    [0.256, '0.00%', '25.60%'],
    [1234567, '#,##0,', '1,235'],
    [1234567, '0.0,,"百万"', '1.2百万'],
    [1234567, '0.00E+00', '1.23E+06'],
    [0.000123, '0.00E+00', '1.23E-04'],
    [12345, '##0.0E+0', '12.3E+3'],
    [9.999, '0.00E+00', '1.00E+01'],
    [1234567, '000-0000', '123-4567'],
    [42, '"¥"#,##0', '¥42'],
    [42, '[$¥-411]#,##0', '¥42'],
    [42, '[$-411]0', '42'],
    [42, '0_);(0)', '42 '],
  ])('%s を %s で → %s', (value, code, expected) => {
    expect(f(value, code)).toBe(expected);
  });

  it('負の数: 1 節なら - を付け、2 節目があれば絶対値をその節で書く', () => {
    expect(f(-1234, '#,##0')).toBe('-1,234');
    expect(f(-1234, '#,##0;(#,##0)')).toBe('(1,234)');
    expect(f(-5, '"¥"#,##0;[Red]"¥"\\-#,##0')).toBe('¥-5');
    expect(f(-0.001, '0.00')).toBe('0.00');
  });

  it('0 の節と文字の節', () => {
    expect(f(0, '0;-0;"ゼロ";@')).toBe('ゼロ');
    expect(f(3, '0;-0;"ゼロ";@')).toBe('3');
    expect(formatTextValue('abc', '0;-0;0;"「"@"」"')).toBe('「abc」');
    expect(formatTextValue('abc', '@"様"')).toBe('abc様');
    expect(formatTextValue('abc', '0.00')).toBeNull();
  });

  it('条件つきの節', () => {
    const code = '[<0]"負";[<100]0;"大"';
    expect(f(-1, code)).toBe('負');
    expect(f(50, code)).toBe('50');
    expect(f(500, code)).toBe('大');
  });

  it('「標準」を含む形', () => {
    expect(f(0.1 + 0.2, 'General')).toBe('0.3');
    expect(f(12, '"合計 "General')).toBe('合計 12');
  });

  it('分数', () => {
    expect(f(1.5, '# ?/?')).toBe('1 1/2');
    expect(f(0.25, '# ?/?')).toBe('1/4');
    expect(f(2, '# ?/?')).toBe('2');
    expect(f(0.3333, '?/100')).toBe('33/100');
    // ?? は分母 99 まで。1/7 より 14/99 のほうが近いので、Excel と同じく 14/99
    expect(f(3.14159, '# ??/??')).toBe('3 14/99');
  });
});

describe('日時', () => {
  // 2024-03-15 13:45:30 のシリアル値（1900 年起点）
  const serial = 45366 + (13 * 3600 + 45 * 60 + 30) / 86400;

  it.each([
    ['yyyy/m/d', '2024/3/15'],
    ['yyyy/mm/dd', '2024/03/15'],
    ['yy-m-d', '24-3-15'],
    ['d-mmm-yy', '15-Mar-24'],
    ['mmmm d, yyyy', 'March 15, 2024'],
    ['ddd', 'Fri'],
    ['dddd', 'Friday'],
    ['aaa', '金'],
    ['aaaa', '金曜日'],
    ['h:mm', '13:45'],
    ['h:mm:ss', '13:45:30'],
    ['h:mm AM/PM', '1:45 PM'],
    ['hh:mm A/P', '01:45 P'],
    ['yyyy"年"m"月"d"日"', '2024年3月15日'],
    ['h"時"mm"分"', '13時45分'],
    ['m/d/yy', '3/15/24'],
    ['mm:ss', '45:30'],
    ['[$-411]ggge"年"m"月"d"日"', '令和6年3月15日'],
    ['[$-411]ge.m.d', 'R6.3.15'],
    ['gge', '令6'],
  ])('%s → %s', (code, expected) => {
    expect(f(serial, code)).toBe(expected);
  });

  it('経過時間（[h]）と秒の小数', () => {
    expect(f(1.5, '[h]:mm:ss')).toBe('36:00:00');
    expect(f(0.25, '[m]')).toBe('360');
    expect(f(1 / 86400 + 0.5 / 86400, 'ss.0')).toBe('01.5');
    expect(f((59 + 0.96) / 86400, 'mm:ss.0')).toBe('01:00.0');
  });

  it('秒への丸めで日付が繰り上がる', () => {
    expect(f(45366 + 0.99999999, 'yyyy/m/d h:mm:ss')).toBe('2024/3/16 0:00:00');
  });

  it('1900 年の閏年の誤り（60 = 1900/2/29）と 1904 年起点', () => {
    expect(f(59, 'yyyy/m/d')).toBe('1900/2/28');
    expect(f(60, 'yyyy/m/d')).toBe('1900/2/29');
    expect(f(61, 'yyyy/m/d')).toBe('1900/3/1');
    expect(f(1, 'yyyy/m/d')).toBe('1900/1/1');
    expect(f(1, 'dddd')).toBe('Sunday');
    expect(f(0, 'yyyy/m/d', true)).toBe('1904/1/1');
  });

  it('範囲外（負・9999 年より後）は日付にしない', () => {
    expect(f(-1, 'yyyy/m/d')).toBeNull();
    expect(serialToParts(3_000_000, false)).toBeNull();
  });

  it('和暦の境目', () => {
    const at = (y: number, m: number, d: number) => eraOf({ year: y, month: m, day: d, weekday: 0, hour: 0, minute: 0, second: 0, fraction: 0 });
    expect(at(2019, 4, 30)?.era.name).toBe('平成');
    expect(at(2019, 4, 30)?.year).toBe(31);
    expect(at(2019, 5, 1)?.era.name).toBe('令和');
    expect(at(2019, 5, 1)?.year).toBe(1);
    expect(at(1989, 1, 7)?.era.name).toBe('昭和');
    expect(at(1989, 1, 7)?.year).toBe(64);
  });

  it('ISO 8601 の日時（t="d"）をシリアル値に', () => {
    expect(isoToSerial('2024-03-15', false)).toBe(45366);
    expect(isoToSerial('1900-01-01', false)).toBe(1);
    expect(isoToSerial('1900-03-01', false)).toBe(61);
    expect(isoToSerial('2024-03-15T12:00:00', false)).toBe(45366.5);
    expect(isoToSerial('1904-01-02', true)).toBe(1);
    expect(isoToSerial('not a date', false)).toBeNull();
  });

  it('日時の形かどうか', () => {
    expect(isDateFormat('yyyy/m/d')).toBe(true);
    expect(isDateFormat('[h]:mm')).toBe(true);
    expect(isDateFormat('#,##0')).toBe(false);
    expect(isDateFormat('"d"0')).toBe(false);
  });
});

describe('組み込みの表示形式（日本語）', () => {
  it('番号から引ける。知らない番号は null', () => {
    expect(builtinFormat(14)).toBe('yyyy/m/d');
    expect(builtinFormat(31)).toBe('yyyy"年"m"月"d"日"');
    expect(builtinFormat(49)).toBe('@');
    expect(builtinFormat(23)).toBeNull();
    expect(f(45366, builtinFormat(14) ?? '')).toBe('2024/3/15');
    expect(f(-1234, builtinFormat(6) ?? '')).toBe('¥-1,234');
  });
});

describe('壊れた表示形式でも例外を投げない', () => {
  it.each(['"', '[', '0.0.0', '#,,,,,', 'E+', ';;;;;', '[<abc]0', 'yyyy"', '\\', '0/0/0', '[h', '@@@'])('%s', (code) => {
    expect(() => f(1234.5, code)).not.toThrow();
    expect(() => formatTextValue('x', code)).not.toThrow();
  });
});

describe('セルに表示形式を当てる', () => {
  it('styles.xml の numFmtId / formatCode で表示し、比較は生の値のまま', () => {
    const styles =
      '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="#,##0&quot;個&quot;"/></numFmts>' +
      '<fonts><font/></fonts><fills><fill/></fills><borders><border/></borders>' +
      '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="49"/></cellXfs></styleSheet>';
    const xml =
      '<worksheet><sheetData><row r="1">' +
      '<c r="A1" s="1"><v>45366</v></c>' +
      '<c r="B1" s="2"><v>12345</v></c>' +
      '<c r="C1" s="3" t="inlineStr"><is><t>abc</t></is></c>' +
      '<c r="D1"><v>0.30000000000000004</v></c>' +
      '<c r="E1" s="1" t="d"><v>2024-03-15T00:00:00</v></c>' +
      '</row></sheetData></worksheet>';
    const r = openWorkbook(buildXlsx({ sheets: [{ name: 'a', xml }], extraParts: [{ name: 'xl/styles.xml', data: styles }] }), identityInflater);
    if (!r.ok) throw new Error('open');
    const ctx = formatContextOf(r.workbook);
    const cells = r.workbook.sheets[0]?.data?.rows[0]?.cells ?? [];
    expect(cells.map((c) => formattedText(c, ctx))).toEqual(['2024/3/15', '12,345個', 'abc', '0.3', '2024/3/15']);
  });
});
