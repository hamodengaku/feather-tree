/*
 * セルの書式（`xl/styles.xml`）の読み取り（決定 33 の M2）。
 *
 * セルの `s` 属性は `<cellXfs>` の添字で、そこから fonts / fills / borders / numFmts を引く。
 * ここでは `<cellXfs>` の 1 件ずつを**解決済みの書式**（色は #rrggbb）にして返す。
 * セル・行・列は添字だけを持ち、描画のときにここを引く。
 *
 * 読むもの: numFmts、fonts（太字・斜体・下線・取り消し線・色・大きさ）、fills（パターンの塗り）、
 * borders（上下左右の線の種類と色）、cellXfs（上 4 つの添字と配置）、indexedColors の差し替え。
 * 読まないもの: cellStyleXfs の継承、dxfs（条件付き書式）、グラデーションの塗り（最初の色で近似）。
 */

import { XML_END, XML_EOF, XML_START, XmlScanner } from '../xml/scanner.js';
import { DEFAULT_INDEXED, NO_COLOR, normalizeRgb, resolveColor, type ColorSpec } from './colors.js';

export type BorderStyle =
  | 'thin'
  | 'medium'
  | 'thick'
  | 'dashed'
  | 'dotted'
  | 'double'
  | 'hair'
  | 'mediumDashed'
  | 'dashDot'
  | 'mediumDashDot'
  | 'dashDotDot'
  | 'mediumDashDotDot'
  | 'slantDashDot';

const BORDER_STYLES: readonly BorderStyle[] = [
  'thin',
  'medium',
  'thick',
  'dashed',
  'dotted',
  'double',
  'hair',
  'mediumDashed',
  'dashDot',
  'mediumDashDot',
  'dashDotDot',
  'mediumDashDotDot',
  'slantDashDot',
];

export type HorizontalAlign = 'general' | 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed';
export type VerticalAlign = 'top' | 'center' | 'bottom' | 'justify' | 'distributed';

const H_ALIGNS: readonly HorizontalAlign[] = ['general', 'left', 'center', 'right', 'fill', 'justify', 'centerContinuous', 'distributed'];
const V_ALIGNS: readonly VerticalAlign[] = ['top', 'center', 'bottom', 'justify', 'distributed'];

export interface BorderEdge {
  readonly style: BorderStyle;
  readonly color: string | null;
}

export interface CellStyle {
  readonly numFmtId: number;
  /** 書式の文字列（ユーザー定義）。組み込みの番号なら null（M3 の format が番号から引く）。 */
  readonly numFmtCode: string | null;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  /** 文字の色。既定（自動）なら null。 */
  readonly color: string | null;
  /** 文字の大きさ（pt）。 */
  readonly sizePt: number | null;
  /** 塗り。無ければ null。 */
  readonly fill: string | null;
  readonly borderTop: BorderEdge | null;
  readonly borderRight: BorderEdge | null;
  readonly borderBottom: BorderEdge | null;
  readonly borderLeft: BorderEdge | null;
  readonly horizontal: HorizontalAlign | null;
  readonly vertical: VerticalAlign | null;
  readonly wrap: boolean;
  readonly indent: number;
}

export interface StyleTable {
  /** `<cellXfs>` の添字で引く。 */
  readonly cells: readonly CellStyle[];
  /** ユーザー定義の書式（numFmtId → 書式の文字列）。 */
  readonly numFmts: ReadonlyMap<number, string>;
  /** 既定のフォントの大きさ（fonts[0]）。 */
  readonly defaultSizePt: number;
}

interface RawFont {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: ColorSpec;
  sizePt: number | null;
}

interface RawBorderEdge {
  style: BorderStyle;
  color: ColorSpec;
}

interface RawBorder {
  top: RawBorderEdge | null;
  right: RawBorderEdge | null;
  bottom: RawBorderEdge | null;
  left: RawBorderEdge | null;
}

interface RawXf {
  numFmtId: number;
  fontId: number;
  fillId: number;
  borderId: number;
  horizontal: HorizontalAlign | null;
  vertical: VerticalAlign | null;
  wrap: boolean;
  indent: number;
}

function readColor(x: XmlScanner): ColorSpec {
  const theme = x.attrInt('theme', -1);
  const indexed = x.attrInt('indexed', -1);
  return {
    rgb: x.attr('rgb'),
    theme: theme >= 0 ? theme : null,
    tint: x.attrNumber('tint', 0),
    indexed: indexed >= 0 ? indexed : null,
    auto: x.attrBool('auto', false),
  };
}

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** `<b/>` と `<b val="0"/>` の両方がある。val が無ければ真。 */
function flag(x: XmlScanner): boolean {
  const v = x.attr('val');
  return v === null || v === '1' || v === 'true';
}

export function parseStyles(bytes: Uint8Array, theme: readonly string[]): StyleTable {
  const numFmts = new Map<number, string>();
  const fonts: RawFont[] = [];
  const fills: ColorSpec[] = [];
  const borders: RawBorder[] = [];
  const xfs: RawXf[] = [];
  const indexed: string[] = [];

  const x = new XmlScanner(bytes);
  // 今どの一覧の中にいるか
  let section = '';
  let font: RawFont | null = null;
  let fill: ColorSpec | null = null;
  let fillPattern: string | null = null;
  let fillFg: ColorSpec | null = null;
  let fillBg: ColorSpec | null = null;
  let border: RawBorder | null = null;
  let edge: 'top' | 'right' | 'bottom' | 'left' | null = null;
  let edgeStyle: BorderStyle | null = null;
  let xf: RawXf | null = null;

  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k === XML_START) {
      if (x.nameIs('numFmts') || x.nameIs('fonts') || x.nameIs('fills') || x.nameIs('borders') || x.nameIs('cellXfs') || x.nameIs('indexedColors') || x.nameIs('cellStyleXfs') || x.nameIs('dxfs') || x.nameIs('mruColors')) {
        section = x.name();
        continue;
      }
      switch (section) {
        case 'numFmts':
          if (x.nameIs('numFmt')) {
            const id = x.attrInt('numFmtId', -1);
            const code = x.attr('formatCode');
            if (id >= 0 && code !== null) numFmts.set(id, code);
          }
          break;
        case 'fonts':
          if (x.nameIs('font')) {
            font = { bold: false, italic: false, underline: false, strike: false, color: NO_COLOR, sizePt: null };
            if (x.selfClosing) {
              fonts.push(font);
              font = null;
            }
          } else if (font !== null) {
            if (x.nameIs('b')) font.bold = flag(x);
            else if (x.nameIs('i')) font.italic = flag(x);
            else if (x.nameIs('strike')) font.strike = flag(x);
            else if (x.nameIs('u')) font.underline = x.attr('val') !== 'none';
            else if (x.nameIs('color')) font.color = readColor(x);
            else if (x.nameIs('sz')) {
              const sz = x.attrNumber('val', NaN);
              font.sizePt = Number.isFinite(sz) && sz > 0 && sz < 410 ? sz : null;
            }
          }
          break;
        case 'fills':
          if (x.nameIs('fill')) {
            fill = NO_COLOR;
            fillPattern = null;
            fillFg = null;
            fillBg = null;
            if (x.selfClosing) {
              fills.push(NO_COLOR);
              fill = null;
            }
          } else if (fill !== null) {
            if (x.nameIs('patternFill')) fillPattern = x.attr('patternType');
            else if (x.nameIs('fgColor')) fillFg = readColor(x);
            else if (x.nameIs('bgColor')) fillBg = readColor(x);
            // グラデーションは最初の色で近似する
            else if (x.nameIs('stop') && fillFg === null) fillPattern = 'solid';
            else if (x.nameIs('color') && fillFg === null && fillPattern === 'solid') fillFg = readColor(x);
          }
          break;
        case 'borders':
          if (x.nameIs('border')) {
            border = { top: null, right: null, bottom: null, left: null };
            if (x.selfClosing) {
              borders.push(border);
              border = null;
            }
          } else if (border !== null) {
            const side = x.nameIs('top') ? 'top' : x.nameIs('bottom') ? 'bottom' : x.nameIs('left') || x.nameIs('start') ? 'left' : x.nameIs('right') || x.nameIs('end') ? 'right' : null;
            if (side !== null) {
              edge = side;
              edgeStyle = pick(x.attr('style'), BORDER_STYLES);
              if (edgeStyle !== null) border[side] = { style: edgeStyle, color: NO_COLOR };
              if (x.selfClosing) edge = null;
            } else if (edge !== null && x.nameIs('color') && edgeStyle !== null) {
              border[edge] = { style: edgeStyle, color: readColor(x) };
            }
          }
          break;
        case 'cellXfs':
          if (x.nameIs('xf')) {
            xf = {
              numFmtId: Math.max(0, x.attrInt('numFmtId', 0)),
              fontId: Math.max(0, x.attrInt('fontId', 0)),
              fillId: Math.max(0, x.attrInt('fillId', 0)),
              borderId: Math.max(0, x.attrInt('borderId', 0)),
              horizontal: null,
              vertical: null,
              wrap: false,
              indent: 0,
            };
            if (x.selfClosing) {
              xfs.push(xf);
              xf = null;
            }
          } else if (xf !== null && x.nameIs('alignment')) {
            xf.horizontal = pick(x.attr('horizontal'), H_ALIGNS);
            xf.vertical = pick(x.attr('vertical'), V_ALIGNS);
            xf.wrap = x.attrBool('wrapText', false);
            xf.indent = Math.max(0, Math.min(15, x.attrInt('indent', 0)));
          }
          break;
        case 'indexedColors':
          if (x.nameIs('rgbColor')) indexed.push(normalizeRgb(x.attr('rgb')) ?? '#000000');
          break;
        default:
          break;
      }
      continue;
    }
    if (k !== XML_END) continue;
    if (x.nameIs(section)) {
      section = '';
      continue;
    }
    if (section === 'fonts' && x.nameIs('font') && font !== null) {
      fonts.push(font);
      font = null;
    } else if (section === 'fills' && x.nameIs('fill') && fill !== null) {
      // 模様の塗りは前景色（fgColor）が塗りの色。none / gray125 は塗りなし
      const solid = fillPattern !== null && fillPattern !== 'none' && fillPattern !== 'gray125';
      fills.push(solid ? (fillFg ?? fillBg ?? NO_COLOR) : NO_COLOR);
      fill = null;
    } else if (section === 'borders' && border !== null) {
      if (x.nameIs('border')) {
        borders.push(border);
        border = null;
      } else if (x.nameIs('top') || x.nameIs('bottom') || x.nameIs('left') || x.nameIs('right') || x.nameIs('start') || x.nameIs('end')) {
        edge = null;
      }
    } else if (section === 'cellXfs' && x.nameIs('xf') && xf !== null) {
      xfs.push(xf);
      xf = null;
    }
  }

  const palette = indexed.length > 0 ? indexed.concat(DEFAULT_INDEXED.slice(indexed.length)) : DEFAULT_INDEXED;
  const color = (spec: ColorSpec): string | null => resolveColor(spec, theme, palette);
  const resolveEdge = (e: RawBorderEdge | null): BorderEdge | null => (e === null ? null : { style: e.style, color: color(e.color) });
  const defaultSize = fonts[0]?.sizePt ?? 11;

  const cells = xfs.map((raw): CellStyle => {
    const f = fonts[raw.fontId] ?? fonts[0];
    const b = borders[raw.borderId];
    const fillSpec = fills[raw.fillId] ?? NO_COLOR;
    return {
      numFmtId: raw.numFmtId,
      numFmtCode: numFmts.get(raw.numFmtId) ?? null,
      bold: f?.bold ?? false,
      italic: f?.italic ?? false,
      underline: f?.underline ?? false,
      strike: f?.strike ?? false,
      color: f === undefined ? null : color(f.color),
      sizePt: f?.sizePt ?? null,
      fill: fillSpec === NO_COLOR ? null : color(fillSpec),
      borderTop: resolveEdge(b?.top ?? null),
      borderRight: resolveEdge(b?.right ?? null),
      borderBottom: resolveEdge(b?.bottom ?? null),
      borderLeft: resolveEdge(b?.left ?? null),
      horizontal: raw.horizontal,
      vertical: raw.vertical,
      wrap: raw.wrap,
      indent: raw.indent,
    };
  });

  return { cells, numFmts, defaultSizePt: defaultSize };
}
