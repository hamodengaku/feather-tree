/*
 * Excel の「標準（General）」書式での数値の見え方（決定 33 の M1）。
 *
 * Excel は数値を有効数字 15 桁で保持し、標準書式では 11 文字程度に丸めて見せる。
 * `0.1 + 0.2` は `0.3`、`123456789012` は `1.23457E+11`、`0.000012345678` は `1.23457E-05` になる。
 * ここではその近似を作る（列幅による丸めの違いまでは追わない）。
 *
 * 規則:
 *   1. 絶対値が 1e11 以上なら指数表記
 *   2. 有効数字 10 桁で丸めて 10 進で書く（浮動小数の端数を消す）
 *   3. 11 文字を超えたら、1 以上は小数を詰めて 11 文字に収め、1 未満は指数表記
 */

const WIDTH = 11;

export function formatGeneral(value: number): string {
  if (!Number.isFinite(value)) return '#NUM!';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e11) return formatExponential(value);

  const rounded = Number.parseFloat(value.toPrecision(10));
  const text = plainString(rounded);
  if (text.length <= WIDTH) return text;
  if (abs < 1) return formatExponential(value);

  const intLength = String(Math.trunc(Math.abs(rounded))).length + (rounded < 0 ? 1 : 0);
  // 小数点の 1 文字ぶんを引いた残りを小数に使う
  const decimals = Math.max(0, WIDTH - intLength - 1);
  return trimZeros(rounded.toFixed(decimals));
}

/** 指数表記にならない 10 進の文字列。 */
function plainString(value: number): string {
  const text = String(value);
  if (!text.includes('e')) return text;
  return trimZeros(value.toFixed(20));
}

function trimZeros(text: string): string {
  if (!text.includes('.')) return text;
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 48) end -= 1;
  if (text.charCodeAt(end - 1) === 46) end -= 1;
  return text.slice(0, end);
}

/** `1.23457E+11` の形。 */
function formatExponential(value: number): string {
  const [mantissa = '0', exponent = '0'] = value.toExponential(5).split('e');
  const exp = Number.parseInt(exponent, 10);
  const sign = exp < 0 ? '-' : '+';
  const digits = String(Math.abs(exp)).padStart(2, '0');
  return trimZeros(mantissa) + 'E' + sign + digits;
}
