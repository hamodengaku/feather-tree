/*
 * SpreadsheetML の色の解決（決定 33 の M2）。
 *
 * 色は 4 通りの書き方がある:
 *   - `rgb="FFRRGGBB"`（ARGB。先頭の A は無視する。Excel も描画で使わない）
 *   - `theme="n"` + `tint`（テーマの色を明るく / 暗くしたもの）
 *   - `indexed="n"`（旧来の 64 色のパレット。styles.xml の `<indexedColors>` で差し替えられる）
 *   - `auto="1"`（既定の色。ここでは null を返し、描画側が既定の色を使う）
 *
 * **返すのは常に `#rrggbb`（小文字）か null。** この文字列は renderer で CSS に流れるので、
 * 形を検証したものしか返さない（ファイルの中身は信頼できない入力）。
 */

export interface ColorSpec {
  readonly rgb: string | null;
  readonly theme: number | null;
  readonly tint: number;
  readonly indexed: number | null;
  readonly auto: boolean;
}

export const NO_COLOR: ColorSpec = { rgb: null, theme: null, tint: 0, indexed: null, auto: false };

/** 既定の indexed パレット（ECMA-376 Part 1 §18.8.27）。64 = 前景（黒）、65 = 背景（白）。 */
export const DEFAULT_INDEXED: readonly string[] = [
  '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff',
  '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff',
  '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#c0c0c0', '#808080',
  '#9999ff', '#993366', '#ffffcc', '#ccffff', '#660066', '#ff8080', '#0066cc', '#ccccff',
  '#000080', '#ff00ff', '#ffff00', '#00ffff', '#800080', '#800000', '#008080', '#0000ff',
  '#00ccff', '#ccffff', '#ccffcc', '#ffff99', '#99ccff', '#ff99cc', '#cc99ff', '#ffcc99',
  '#3366ff', '#33cccc', '#99cc00', '#ffcc00', '#ff9900', '#ff6600', '#666699', '#969696',
  '#003366', '#339966', '#003300', '#333300', '#993300', '#993366', '#333399', '#333333',
  '#000000', '#ffffff',
];

/** Office の既定テーマ（テーマの部品が無いブック用）。並びは clrScheme の順（dk1, lt1, dk2, lt2, accent1〜6, hlink, folHlink）。 */
export const DEFAULT_THEME: readonly string[] = [
  '#000000', '#ffffff', '#44546a', '#e7e6e6', '#4472c4', '#ed7d31',
  '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47', '#0563c1', '#954f72',
];

const HEX6 = /^[0-9a-fA-F]{6}$/;

/** `FFRRGGBB` / `RRGGBB` を `#rrggbb` に。形が違えば null。 */
export function normalizeRgb(text: string | null): string | null {
  if (text === null) return null;
  const t = text.trim();
  const six = t.length === 8 ? t.slice(2) : t;
  return HEX6.test(six) ? '#' + six.toLowerCase() : null;
}

/**
 * テーマ色の番号 → clrScheme の並びの添字。
 * **最初の 2 組は入れ替わる**（テーマ番号 0 = lt1、1 = dk1、2 = lt2、3 = dk2。Excel の実装に合わせる）。
 */
export function themeSlot(index: number): number {
  if (index === 0) return 1;
  if (index === 1) return 0;
  if (index === 2) return 3;
  if (index === 3) return 2;
  return index;
}

export function resolveColor(
  spec: ColorSpec,
  theme: readonly string[],
  indexed: readonly string[],
): string | null {
  if (spec.auto) return null;
  let base: string | null = null;
  if (spec.rgb !== null) base = normalizeRgb(spec.rgb);
  else if (spec.theme !== null) base = theme[themeSlot(spec.theme)] ?? DEFAULT_THEME[themeSlot(spec.theme)] ?? null;
  else if (spec.indexed !== null) base = indexed[spec.indexed] ?? DEFAULT_INDEXED[spec.indexed] ?? null;
  if (base === null) return null;
  return spec.tint === 0 ? base : applyTint(base, spec.tint);
}

/**
 * tint を掛ける（ECMA-376 §18.8.19。HLS の明度だけを動かす）。
 * tint < 0 なら暗く（L × (1 + tint)）、tint > 0 なら明るく（L × (1 − tint) + (1 − (1 − tint))）。
 */
export function applyTint(hex: string, tint: number): string {
  const t = Math.max(-1, Math.min(1, tint));
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const [h, l, s] = rgbToHls(r, g, b);
  const lum = t < 0 ? l * (1 + t) : l * (1 - t) + t;
  const [nr, ng, nb] = hlsToRgb(h, Math.max(0, Math.min(1, lum)), s);
  return '#' + [nr, ng, nb].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

function rgbToHls(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, l, 0];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, l, s];
}

function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
}
