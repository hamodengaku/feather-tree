import { describe, expect, it } from 'vitest';
import { IDENTITY_MAP, buildRowMap, remapFormula, remapRefText, remapSqref, type FormulaContext, type RowMap } from '../src/write/refs.js';
import { crc32, writeZip } from '../src/write/zipWriter.js';
import { openZip, readZipEntry, type InflateResult } from '../src/index.js';
import { buildZip } from './zipBuilder.js';

/*
 * 行の挿入・削除の参照の付け替え（docs/07 5.2）と ZIP の書き出し（docs/07 2 章）。
 * 行番号は 0 始まり。表示の行番号（A5 の 5）は 1 始まりなので、例は両方を書く。
 */

/** 行 3（4 行目）の前に 1 行挿入: 0,1,2 → そのまま、3 以降 → +1 */
const insertAt3 = buildRowMap(Int32Array.from([0, 1, 2, 4, 5, 6, 7, 8, 9]), 1);
/** 行 3（4 行目）を削除: 3 → 消える、4 以降 → -1 */
const deleteRow3 = buildRowMap(Int32Array.from([0, 1, 2, -1, 3, 4, 5, 6, 7]), -1);

function ctx(sheet: string | null, maps: Record<string, RowMap>): FormulaContext {
  const lower = new Map(Object.entries(maps).map(([k, v]) => [k.toLowerCase(), v]));
  return { sheet, map: (name) => lower.get(name.toLowerCase()) ?? null, anyChanged: lower.size > 0 };
}

describe('参照の付け替え', () => {
  it('挿入: 挿入点より下のセルは $ の有無を問わずずれる。範囲は広がる', () => {
    const c = ctx('S', { S: insertAt3 });
    expect(remapFormula('A3+A4+$B$5+B$9', c).text).toBe('A3+A5+$B$6+B$10');
    expect(remapFormula('SUM(A2:A9)', c).text).toBe('SUM(A2:A10)');
    expect(remapFormula('SUM(4:6)', c).text).toBe('SUM(5:7)');
    expect(remapFormula('SUM(A:C)', c).text).toBe('SUM(A:C)');
  });

  it('削除: 消えた行のセルは #REF!、範囲は縮む、全部消えたら #REF!', () => {
    const c = ctx('S', { S: deleteRow3 });
    expect(remapFormula('A4', c).text).toBe('#REF!');
    expect(remapFormula('A5*2', c).text).toBe('A4*2');
    expect(remapFormula('SUM(A2:A6)', c).text).toBe('SUM(A2:A5)');
    expect(remapFormula('SUM(A4:A4)', c).text).toBe('SUM(#REF!)');
    // 範囲の端が消えた行: 内側へ寄せる
    expect(remapFormula('SUM(A4:A6)', c).text).toBe('SUM(A4:A5)');
  });

  it('シートの修飾で行き先を決める（引用符付き・大文字小文字を区別しない）', () => {
    const c = ctx('Other', { 'My Sheet': insertAt3, Data: deleteRow3 });
    expect(remapFormula("'My Sheet'!A5+my sheet!A5", c).text).toBe("'My Sheet'!A6+my sheet!A5");
    expect(remapFormula('DATA!A5+A5', c).text).toBe('DATA!A4+A5');
    expect(remapFormula("'My Sheet'!A5", c).touched).toBe(true);
    expect(remapFormula('A5', c).touched).toBe(false);
  });

  it('文字列・関数名・外部ブック・構造化参照は変えない', () => {
    const c = ctx('S', { S: insertAt3 });
    expect(remapFormula('"A5"&LOG10(A5)', c).text).toBe('"A5"&LOG10(A6)');
    expect(remapFormula('[1]S!A5+Table1[Col]', c).text).toBe('[1]S!A5+Table1[Col]');
    expect(remapFormula("'[1]S'!A5", c).text).toBe("'[1]S'!A5");
  });

  it('3D 参照は行を変えたシートがあると断る', () => {
    expect(() => remapFormula('SUM(S1:S3!A1)', ctx('S', { S: insertAt3 }))).toThrow();
    expect(remapFormula('SUM(S1:S3!A1)', ctx('S', {})).text).toBe('SUM(S1:S3!A1)');
  });

  it('範囲の属性・sqref', () => {
    expect(remapRefText('A2:C9', insertAt3)).toBe('A2:C10');
    expect(remapRefText('A4:B4', deleteRow3)).toBeNull();
    expect(remapSqref('A1 A4 B5:B6', deleteRow3)).toBe('A1 B4:B5');
    expect(remapSqref('A4', deleteRow3)).toBeNull();
    expect(remapRefText('A4', IDENTITY_MAP)).toBe('A4');
  });

  it('表より下の行は tailShift でずれる。シートの外へ出る範囲の終わりは最終行で止める', () => {
    expect(insertAt3.point(100)).toBe(101);
    expect(remapRefText('A1:A1048576', insertAt3)).toBe('A1:A1048576');
    expect(remapRefText('A1048576', insertAt3)).toBeNull();
  });
});

/*
 * このパッケージのテストは Node を使えないので、deflate / inflate は恒等写像で代える（本物は core のテストで通す）。
 * 方式の番号は deflate のまま書かれるので、読み出しでは同じ恒等写像の inflate を通る。
 */
const deflateRawSync = (d: Uint8Array): Uint8Array => d;
const inflate = (data: Uint8Array, max: number): InflateResult =>
  data.length > max ? { ok: false, reason: 'too-large' } : { ok: true, data };

describe('ZIP の書き出し', () => {
  it('写した部品は圧縮済みバイトのまま、書き換えた部品は deflate し直す', () => {
    const src = buildZip([
      { name: 'a.xml', data: '<a/>' },
      { name: 'b.xml', data: '<b>' + 'x'.repeat(1000) + '</b>' },
    ], { deflate: (d) => deflateRawSync(d) });
    const zip = openZip(src);
    if (!zip.ok) throw new Error('zip');
    const a = zip.archive.entries.get('a.xml');
    if (a === undefined) throw new Error('a');
    const out = writeZip(
      zip.archive,
      [{ kind: 'copy', entry: a }, { kind: 'data', name: 'c.xml', data: new TextEncoder().encode('<c>新</c>') }],
      (d) => deflateRawSync(d),
    );
    if (!out.ok) throw new Error('write');
    const back = openZip(out.bytes);
    if (!back.ok) throw new Error('reopen');
    expect([...back.archive.entries.keys()]).toEqual(['a.xml', 'c.xml']);
    const read = (name: string): string => {
      const e = back.archive.entries.get(name);
      if (e === undefined) throw new Error(name);
      const r = readZipEntry(back.archive, e, inflate, 1 << 20);
      if (!r.ok) throw new Error(r.reason);
      return new TextDecoder().decode(r.data);
    };
    expect(read('a.xml')).toBe('<a/>');
    expect(read('c.xml')).toBe('<c>新</c>');
    expect(back.archive.entries.get('c.xml')?.crc32).toBe(crc32(new TextEncoder().encode('<c>新</c>')));
  });
});
