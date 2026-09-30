import { describe, expect, it } from 'vitest';
import type { ExcelCellStyleDto } from '@feathertree/ipc';
import { cellCss, generalAlign, styleIndexFor } from '../src/lib/excelStyle.js';

/*
 * セルの書式 → CSS（決定 33 の M2）。**CSS に流すのは検証した値だけ**であることをここで固定する。
 */

const base: ExcelCellStyleDto = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: null,
  sizePt: 11,
  fill: null,
  borderTop: null,
  borderRight: null,
  borderBottom: null,
  borderLeft: null,
  horizontal: null,
  vertical: null,
  wrap: false,
  indent: 0,
};

describe('セルの書式 → CSS', () => {
  it('書式が無ければ配置だけ（数値は右、文字は左、真偽は中央）', () => {
    expect(cellCss(undefined, 1, 11)).toEqual({ text: 'text-align:right', filled: false });
    expect(cellCss(undefined, 2, 11).text).toBe('text-align:left');
    expect(generalAlign(3)).toBe('center');
  });

  it('色・太字・斜体・下線・取り消し線・大きさ・塗り', () => {
    const css = cellCss({ ...base, bold: true, italic: true, underline: true, strike: true, color: '#ff0000', sizePt: 14, fill: '#ffff00' }, 2, 11);
    expect(css.filled).toBe(true);
    expect(css.text).toContain('background-color:#ffff00');
    expect(css.text).toContain('color:#ff0000');
    expect(css.text).toContain('font-weight:700');
    expect(css.text).toContain('font-style:italic');
    expect(css.text).toContain('text-decoration:underline line-through');
    expect(css.text).toContain('font-size:14pt');
  });

  it('既定と同じ大きさなら font-size を書かない', () => {
    expect(cellCss(base, 2, 11).text).not.toContain('font-size');
  });

  it('罫線は種類ごとに太さと線の形へ。色が無ければ黒', () => {
    const css = cellCss(
      {
        ...base,
        borderTop: { style: 'thin', color: '#00ff00' },
        borderBottom: { style: 'double', color: null },
        borderLeft: { style: 'mediumDashed', color: '#123456' },
        borderRight: { style: 'unknown', color: '#123456' },
      },
      2,
      11,
    ).text;
    expect(css).toContain('border-top:1px solid #00ff00');
    expect(css).toContain('border-bottom:3px double #000000');
    expect(css).toContain('border-left:2px dashed #123456');
    expect(css).not.toContain('border-right');
  });

  it('配置・折り返し・字下げ', () => {
    const css = cellCss({ ...base, horizontal: 'center', vertical: 'top', wrap: true, indent: 2 }, 1, 11).text;
    expect(css).toContain('text-align:center');
    expect(css).toContain('justify-content:flex-start');
    expect(css).toContain('white-space:pre-wrap');
    expect(css).toContain('padding-left:21px');
  });

  it('形の違う値は CSS に流さない（色への注入・知らない配置・大きすぎる字下げ）', () => {
    const css = cellCss(
      {
        ...base,
        color: 'red;background:url(https://example.invalid/x)',
        fill: '#fff',
        horizontal: 'left;position:fixed',
        vertical: 'middle',
        indent: 999,
        sizePt: 9999,
        borderTop: { style: 'thin', color: 'url(x)' },
      },
      2,
      11,
    );
    expect(css.text).not.toContain('url(');
    expect(css.text).not.toContain('position');
    expect(css.text).not.toContain('justify-content');
    expect(css.filled).toBe(false);
    expect(css.text).toContain('padding-left:138px');
    expect(css.text).toContain('font-size:72pt');
    expect(css.text).toContain('border-top:1px solid #000000');
    expect(css.text).toContain('text-align:left');
  });
});

describe('効く書式の順（セル → 行 → 列）', () => {
  it('セルの書式が最優先で、無ければ行、行にも無ければ列、どれも無ければ 0', () => {
    expect(styleIndexFor(5, 3, 2)).toBe(5);
    expect(styleIndexFor(undefined, 3, 2)).toBe(3);
    expect(styleIndexFor(undefined, -1, 2)).toBe(2);
    expect(styleIndexFor(undefined, -1, -1)).toBe(0);
    expect(styleIndexFor(0, 3, 2)).toBe(0);
  });
});
