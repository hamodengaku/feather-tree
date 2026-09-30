/*
 * セルの書式 → CSS（決定 33 の M2）。**純関数だけ。**
 *
 * ファイルの中身は信頼できない入力なので、CSS に流すのは**ここで形を確かめた値だけ**:
 *   - 色は `#rrggbb` の形のものだけ（excel 層でも検証済みだが、境界ごとに確かめる）
 *   - 線の種類・配置は決まった語の中からだけ選ぶ
 *   - 数値（フォントの大きさ・字下げ）は範囲に丸める
 * フォント名は受け取らない（contract.ts の注記）。
 */

import type { ExcelBorderDto, ExcelCellStyleDto } from '@feathertree/ipc';

const HEX = /^#[0-9a-f]{6}$/;

function safeColor(value: string | null | undefined): string | null {
  return typeof value === 'string' && HEX.test(value) ? value : null;
}

/** SpreadsheetML の線の種類 → CSS の太さと種類。 */
const BORDER_CSS: Readonly<Record<string, string>> = {
  thin: '1px solid',
  hair: '1px dotted',
  dotted: '1px dotted',
  dashed: '1px dashed',
  dashDot: '1px dashed',
  dashDotDot: '1px dashed',
  slantDashDot: '1px dashed',
  medium: '2px solid',
  mediumDashed: '2px dashed',
  mediumDashDot: '2px dashed',
  mediumDashDotDot: '2px dashed',
  thick: '3px solid',
  double: '3px double',
};

function borderCss(edge: ExcelBorderDto | null): string | null {
  if (edge === null) return null;
  const line = BORDER_CSS[edge.style];
  if (line === undefined) return null;
  return line + ' ' + (safeColor(edge.color) ?? '#000000');
}

const H_ALIGN: Readonly<Record<string, string>> = {
  left: 'left',
  center: 'center',
  right: 'right',
  justify: 'justify',
  distributed: 'justify',
  fill: 'left',
  centerContinuous: 'center',
};

/** 縦の配置 → flex の justify-content（セルは縦向きの flex の箱）。Excel の既定は下寄せ。 */
const V_ALIGN: Readonly<Record<string, string>> = {
  top: 'flex-start',
  center: 'center',
  bottom: 'flex-end',
  justify: 'space-between',
  distributed: 'space-between',
};

/** 値の大分類が数値（1）なら右寄せ、真偽（3）・エラー（4）なら中央（「標準」の配置）。 */
export function generalAlign(kind: number): string {
  if (kind === 1) return 'right';
  if (kind === 3 || kind === 4) return 'center';
  return 'left';
}

export interface CellCss {
  /** style 属性にそのまま入れる文字列（検証済みの値だけで組む）。 */
  readonly text: string;
  /** 塗りがあるか。変更の印（黄色の地）を塗りで上書きしないための目印。 */
  readonly filled: boolean;
}

/**
 * セルの見た目。`kind` は値の大分類（配置の「標準」を決める）。`defaultPt` はそのブックの既定の大きさで、
 * これと同じ大きさなら font-size を書かない（グリッドの既定に任せる）。
 */
export function cellCss(style: ExcelCellStyleDto | undefined, kind: number, defaultPt: number): CellCss {
  const parts: string[] = [];
  let filled = false;
  if (style !== undefined) {
    const fill = safeColor(style.fill);
    if (fill !== null) {
      parts.push('background-color:' + fill);
      filled = true;
    }
    const color = safeColor(style.color);
    if (color !== null) parts.push('color:' + color);
    if (style.bold) parts.push('font-weight:700');
    if (style.italic) parts.push('font-style:italic');
    const deco = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter((d) => d !== '');
    if (deco.length > 0) parts.push('text-decoration:' + deco.join(' '));
    if (typeof style.sizePt === 'number' && Number.isFinite(style.sizePt) && Math.abs(style.sizePt - defaultPt) > 0.01) {
      parts.push('font-size:' + String(Math.min(72, Math.max(4, style.sizePt))) + 'pt');
    }
    const edges: Array<[string, ExcelBorderDto | null]> = [
      ['border-top', style.borderTop],
      ['border-right', style.borderRight],
      ['border-bottom', style.borderBottom],
      ['border-left', style.borderLeft],
    ];
    for (const [prop, edge] of edges) {
      const css = borderCss(edge);
      if (css !== null) parts.push(prop + ':' + css);
    }
    const v = style.vertical === null ? undefined : V_ALIGN[style.vertical];
    if (v !== undefined) parts.push('justify-content:' + v);
    if (style.wrap) parts.push('white-space:pre-wrap', 'overflow-wrap:anywhere');
    const indent = Math.min(15, Math.max(0, Math.trunc(style.indent)));
    if (indent > 0) parts.push('padding-left:' + String(3 + indent * 9) + 'px');
  }
  const h = style?.horizontal === null || style?.horizontal === undefined ? undefined : H_ALIGN[style.horizontal];
  parts.push('text-align:' + (h ?? generalAlign(kind)));
  return { text: parts.join(';'), filled };
}

/**
 * セルに効く書式の添字。セルの書式 → 行の書式（customFormat）→ 列の書式 → 0 の順
 * （ECMA-376: セルが無い位置は行、行にも無ければ列の書式で描く）。
 */
export function styleIndexFor(cellStyle: number | undefined, rowStyle: number, colStyle: number): number {
  if (cellStyle !== undefined) return cellStyle;
  if (rowStyle >= 0) return rowStyle;
  if (colStyle >= 0) return colStyle;
  return 0;
}
