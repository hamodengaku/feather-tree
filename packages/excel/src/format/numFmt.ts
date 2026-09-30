/*
 * 表示形式（numFmt）の解釈（決定 33 の M3）。
 *
 * 扱う形:
 *   - 節（正;負;0;文字）と条件（[<100]）。負の節では絶対値を書く（符号は節の中の文字で表す）
 *   - 数値: 0 # ? . , %（桁区切り・千単位の切り捨て）、E+ / E-、「標準」（General）
 *   - 分数: # ?/? ・ ?/100
 *   - 日時: y m d h s（m は h の後・s の前なら分）、mmm / mmmm、ddd / dddd、aaa / aaaa（日本語の曜日）、
 *     AM/PM・A/P、[h] [m] [s]（経過時間）、秒の小数 .0、和暦 g gg ggg e ee
 *   - 文字: @、"文字" \文字 _x（空白） *x（埋め。無視する）
 *   - [$¥-411]（通貨記号）・[$-411]（ロケール。無視する）・[Red]（色。M3 では色は付けない）
 *
 * **例外を投げない。** 解釈できない形は「標準」で出す（呼び出し側が生の値へ落とす）。
 */

import { formatGeneral } from './general.js';
import { DAY_NAMES, DAY_NAMES_JA, eraOf, MONTH_NAMES, serialToParts, type DateParts } from './date.js';

type DateToken = { readonly t: 'date'; v: string };

type Token =
  | { readonly t: 'lit'; readonly v: string }
  | { readonly t: 'digit'; readonly v: '0' | '#' | '?' }
  | { readonly t: 'point' }
  | { readonly t: 'comma' }
  | { readonly t: 'percent' }
  | { readonly t: 'exp'; readonly sign: '+' | '-' }
  | { readonly t: 'text' }
  | DateToken
  | { readonly t: 'elapsed'; readonly v: 'h' | 'm' | 's'; readonly n: number }
  | { readonly t: 'subsec'; readonly n: number }
  | { readonly t: 'ampm'; readonly v: 'AM/PM' | 'A/P' }
  | { readonly t: 'general' };

interface Condition {
  readonly op: '<' | '<=' | '>' | '>=' | '=' | '<>';
  readonly value: number;
}

interface Section {
  readonly tokens: readonly Token[];
  readonly kind: 'number' | 'date' | 'text' | 'general';
  readonly condition: Condition | null;
  /** 分数の形（# ?/? など）。分数でなければ null。 */
  readonly fraction: FractionSpec | null;
}

interface FractionSpec {
  /** 整数部の桁の形（無ければ空文字 = 帯分数にしない）。 */
  readonly whole: string;
  readonly numerator: string;
  /** 分母の桁の形（? や #）。固定の分母なら空文字。 */
  readonly denominator: string;
  readonly fixedDenominator: number | null;
  /** 分数より前と後の文字。 */
  readonly prefix: string;
  readonly suffix: string;
}

interface Compiled {
  readonly sections: readonly Section[];
}

const cache = new Map<string, Compiled>();
const CACHE_LIMIT = 512;

function compile(code: string): Compiled {
  const hit = cache.get(code);
  if (hit !== undefined) return hit;
  const sections = splitSections(code).map(parseSection);
  const compiled: Compiled = { sections };
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(code, compiled);
  return compiled;
}

/** `;` で節に分ける（引用符・角括弧・\ の中の ; は区切りではない）。 */
function splitSections(code: string): string[] {
  const out: string[] = [];
  let current = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i] ?? '';
    if (c === '"') {
      const end = code.indexOf('"', i + 1);
      const stop = end < 0 ? code.length : end + 1;
      current += code.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '\\' || c === '_' || c === '*') {
      current += code.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '[') {
      const end = code.indexOf(']', i + 1);
      const stop = end < 0 ? code.length : end + 1;
      current += code.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === ';') {
      out.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += c;
    i += 1;
  }
  out.push(current);
  return out;
}

const DATE_LETTERS = new Set(['y', 'm', 'd', 'h', 's', 'g', 'e']);

function parseSection(src: string): Section {
  const tokens: Token[] = [];
  let condition: Condition | null = null;
  let i = 0;
  const lit = (v: string): void => {
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.t === 'lit') tokens[tokens.length - 1] = { t: 'lit', v: last.v + v };
    else tokens.push({ t: 'lit', v });
  };

  while (i < src.length) {
    const c = src[i] ?? '';
    const lower = c.toLowerCase();

    if (c === '"') {
      const end = src.indexOf('"', i + 1);
      lit(src.slice(i + 1, end < 0 ? src.length : end));
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '\\') {
      lit(src[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (c === '_') {
      lit(' ');
      i += 2;
      continue;
    }
    if (c === '*') {
      i += 2;
      continue;
    }
    if (c === '[') {
      const end = src.indexOf(']', i + 1);
      const body = src.slice(i + 1, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 1;
      const elapsed = /^(h+|m+|s+)$/i.exec(body);
      if (elapsed !== null) {
        const v = (elapsed[1] ?? 'h')[0]?.toLowerCase() as 'h' | 'm' | 's';
        tokens.push({ t: 'elapsed', v, n: body.length });
        continue;
      }
      if (body.startsWith('$')) {
        // [$¥-411] は通貨記号 ¥ を出す。[$-411] はロケールだけで何も出さない
        const dash = body.indexOf('-');
        const symbol = body.slice(1, dash < 0 ? body.length : dash);
        if (symbol !== '') lit(symbol);
        continue;
      }
      const cond = /^(<=|>=|<>|<|>|=)\s*(-?[\d.]+(?:[eE][-+]?\d+)?)$/.exec(body);
      if (cond !== null) {
        condition = { op: cond[1] as Condition['op'], value: Number(cond[2]) };
        continue;
      }
      // 色（[Red] / [Color10]）などは描かない
      continue;
    }
    if (c === '@') {
      tokens.push({ t: 'text' });
      i += 1;
      continue;
    }
    if (src.slice(i, i + 7).toLowerCase() === 'general') {
      tokens.push({ t: 'general' });
      i += 7;
      continue;
    }
    if (src.slice(i, i + 5).toUpperCase() === 'AM/PM') {
      tokens.push({ t: 'ampm', v: 'AM/PM' });
      i += 5;
      continue;
    }
    if (src.slice(i, i + 3).toUpperCase() === 'A/P') {
      tokens.push({ t: 'ampm', v: 'A/P' });
      i += 3;
      continue;
    }
    if (lower === 'a' && src.slice(i, i + 3).toLowerCase() === 'aaa') {
      let n = 3;
      while (src[i + n]?.toLowerCase() === 'a') n += 1;
      tokens.push({ t: 'date', v: n >= 4 ? 'aaaa' : 'aaa' });
      i += n;
      continue;
    }
    if (lower === 'e' && (src[i + 1] === '+' || src[i + 1] === '-') && tokens.some((t) => t.t === 'digit')) {
      tokens.push({ t: 'exp', sign: src[i + 1] === '+' ? '+' : '-' });
      i += 2;
      continue;
    }
    if (DATE_LETTERS.has(lower)) {
      let n = 1;
      while (src[i + n]?.toLowerCase() === lower) n += 1;
      tokens.push({ t: 'date', v: lower.repeat(n) });
      i += n;
      continue;
    }
    if (c === '0' || c === '#' || c === '?') {
      tokens.push({ t: 'digit', v: c });
      i += 1;
      continue;
    }
    if (c === '.') {
      const prev = tokens[tokens.length - 1];
      if (prev !== undefined && prev.t === 'date' && prev.v.startsWith('s')) {
        let n = 0;
        while (src[i + 1 + n] === '0') n += 1;
        tokens.push({ t: 'subsec', n });
        i += 1 + n;
        continue;
      }
      tokens.push({ t: 'point' });
      i += 1;
      continue;
    }
    if (c === ',') {
      tokens.push({ t: 'comma' });
      i += 1;
      continue;
    }
    if (c === '%') {
      tokens.push({ t: 'percent' });
      i += 1;
      continue;
    }
    lit(c);
    i += 1;
  }

  resolveMinutes(tokens);

  const hasDate = tokens.some((t) => t.t === 'date' || t.t === 'elapsed' || t.t === 'ampm');
  const hasDigit = tokens.some((t) => t.t === 'digit');
  const kind: Section['kind'] = tokens.some((t) => t.t === 'general')
    ? 'general'
    : hasDate
      ? 'date'
      : tokens.some((t) => t.t === 'text') && !hasDigit
        ? 'text'
        : 'number';
  return { tokens, kind, condition, fraction: kind === 'number' ? parseFraction(src) : null };
}

/** m / mm は、直前の日時の記号が時（h・[h]）か、直後が秒（s）なら「分」。 */
function resolveMinutes(tokens: Token[]): void {
  const dateIndices = tokens.map((t, i) => (t.t === 'date' || t.t === 'elapsed' ? i : -1)).filter((i) => i >= 0);
  dateIndices.forEach((index, k) => {
    const t = tokens[index];
    if (t === undefined || t.t !== 'date' || !(t.v === 'm' || t.v === 'mm')) return;
    const prev = tokens[dateIndices[k - 1] ?? -1];
    const next = tokens[dateIndices[k + 1] ?? -1];
    const afterHour = prev !== undefined && ((prev.t === 'date' && prev.v.startsWith('h')) || (prev.t === 'elapsed' && prev.v === 'h'));
    const beforeSecond = next !== undefined && ((next.t === 'date' && next.v.startsWith('s')) || (next.t === 'elapsed' && next.v === 's'));
    if (afterHour || beforeSecond) tokens[index] = { t: 'date', v: t.v === 'm' ? 'M' : 'MM' };
  });
}

/** 分数の形（引用符などを除いた本体に `#/?` の並びがあるか）。 */
function parseFraction(src: string): FractionSpec | null {
  const plain = src.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/[\\_*]./g, '');
  const m = /^(.*?)(?:([#0?]+)\s+)?([#0?]+)\/([#0?]+|\d+)(.*)$/.exec(plain);
  if (m === null) return null;
  const den = m[4] ?? '';
  const fixed = /^\d+$/.test(den) && !/^[0]+$/.test(den) ? Number(den) : null;
  return {
    whole: m[2] ?? '',
    numerator: m[3] ?? '',
    denominator: fixed === null ? den : '',
    fixedDenominator: fixed,
    prefix: m[1] ?? '',
    suffix: m[5] ?? '',
  };
}

function matches(cond: Condition, v: number): boolean {
  switch (cond.op) {
    case '<':
      return v < cond.value;
    case '<=':
      return v <= cond.value;
    case '>':
      return v > cond.value;
    case '>=':
      return v >= cond.value;
    case '=':
      return v === cond.value;
    default:
      return v !== cond.value;
  }
}

/** 数値に使う節と、絶対値で書くか。 */
function pickSection(sections: readonly Section[], v: number): { section: Section; abs: boolean } | null {
  const numeric = sections.filter((s, i) => !(i === 3 || (s.kind === 'text' && i > 0)));
  if (numeric.length === 0) return null;
  if (numeric.some((s) => s.condition !== null)) {
    for (const s of numeric) {
      if (s.condition !== null && matches(s.condition, v)) return { section: s, abs: false };
    }
    const rest = numeric.find((s) => s.condition === null);
    return rest === undefined ? null : { section: rest, abs: false };
  }
  const [first, second, third] = numeric;
  if (first === undefined) return null;
  if (numeric.length === 1) return { section: first, abs: false };
  if (v < 0 && second !== undefined) return { section: second, abs: true };
  if (v === 0 && third !== undefined) return { section: third, abs: false };
  return { section: first, abs: false };
}

/**
 * 数値を表示形式で文字にする。解釈できなければ null（呼び出し側は「標準」で出す）。
 */
export function formatNumber(value: number, code: string, date1904: boolean): string | null {
  if (!Number.isFinite(value)) return null;
  const picked = pickSection(compile(code).sections, value);
  if (picked === null) return null;
  const { section, abs } = picked;
  const v = abs ? Math.abs(value) : value;
  switch (section.kind) {
    case 'general':
      return renderGeneral(section.tokens, v);
    case 'date':
      return renderDate(section.tokens, v, date1904);
    case 'text':
      // 文字の節しか無い形（@）で数値を出す: 「標準」の数値をそのまま入れる
      return renderText(section.tokens, formatGeneral(v));
    default:
      if (section.fraction !== null) return renderFraction(section.fraction, v);
      return renderNumber(section.tokens, v);
  }
}

/** 文字のセルに表示形式を当てる（4 つ目の節、または @ を含む節）。当てる節が無ければ null。 */
export function formatTextValue(text: string, code: string): string | null {
  const sections = compile(code).sections;
  const target = sections[3] ?? sections.find((s) => s.kind === 'text');
  if (target === undefined) return null;
  return renderText(target.tokens, text);
}

/** その表示形式が日時か（t="d" のセルや、値の見分けに使う）。 */
export function isDateFormat(code: string): boolean {
  return compile(code).sections[0]?.kind === 'date';
}

function renderGeneral(tokens: readonly Token[], v: number): string {
  let out = '';
  for (const t of tokens) {
    if (t.t === 'general') out += formatGeneral(v);
    else if (t.t === 'lit') out += t.v;
  }
  return out;
}

function renderText(tokens: readonly Token[], text: string): string {
  let out = '';
  for (const t of tokens) {
    if (t.t === 'text') out += text;
    else if (t.t === 'lit') out += t.v;
  }
  return out;
}

/* ------------------------------------------------------------ 数値 */

function fill(placeholder: '0' | '#' | '?'): string {
  return placeholder === '0' ? '0' : placeholder === '?' ? ' ' : '';
}

/** 10 進で n 桁に丸めた文字列（浮動小数の誤差を toFixed の前に消す）。 */
function toFixedSafe(v: number, digits: number): string {
  const d = Math.max(0, Math.min(20, digits));
  const shifted = Number(Math.abs(v).toPrecision(15));
  return shifted.toFixed(d);
}

function renderNumber(tokens: readonly Token[], value: number): string {
  const expIndex = tokens.findIndex((t) => t.t === 'exp');
  const mantissaTokens = expIndex < 0 ? tokens : tokens.slice(0, expIndex);
  const pointIndex = mantissaTokens.findIndex((t) => t.t === 'point');
  const intEnd = pointIndex < 0 ? mantissaTokens.length : pointIndex;

  const digitIdx = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (let i = from; i < to; i += 1) if (mantissaTokens[i]?.t === 'digit') out.push(i);
    return out;
  };
  const intPlaces = digitIdx(0, intEnd);
  const fracPlaces = pointIndex < 0 ? [] : digitIdx(pointIndex + 1, mantissaTokens.length);

  // 桁区切り: 整数部の桁の記号に挟まれた , 。千単位の切り捨て: 整数部の最後の桁の直後に続く ,
  const firstInt = intPlaces[0] ?? -1;
  const lastInt = intPlaces[intPlaces.length - 1] ?? -1;
  let grouping = false;
  let scale = 0;
  mantissaTokens.forEach((t, i) => {
    if (t.t !== 'comma') return;
    if (i > firstInt && i < lastInt) grouping = true;
  });
  const lastDigit = Math.max(lastInt, fracPlaces[fracPlaces.length - 1] ?? -1);
  for (let i = lastDigit + 1; i < mantissaTokens.length && mantissaTokens[i]?.t === 'comma'; i += 1) scale += 1;
  const percents = tokens.filter((t) => t.t === 'percent').length;

  let v = Math.abs(value) * 100 ** percents / 1000 ** scale;
  const negative = value < 0;

  let exponent = 0;
  if (expIndex >= 0 && v !== 0) {
    const intCount = Math.max(1, intPlaces.length);
    const engineering = intCount > 1 && intPlaces.some((i) => (mantissaTokens[i] as { v?: string }).v === '#');
    exponent = Math.floor(Math.log10(v));
    exponent = engineering ? Math.floor(exponent / intCount) * intCount : exponent - (Math.max(1, intPlaces.filter((i) => (mantissaTokens[i] as { v?: string }).v === '0').length) - 1);
    v /= 10 ** exponent;
    // 丸めで桁が繰り上がったら指数を直す（9.999 → 10.00）
    const rounded = Number(toFixedSafe(v, fracPlaces.length));
    const limit = engineering ? 10 ** intCount : 10 ** Math.max(1, intPlaces.length);
    if (rounded >= limit) {
      const step = engineering ? intCount : 1;
      exponent += step;
      v /= 10 ** step;
    }
  }

  const fixed = toFixedSafe(v, fracPlaces.length);
  const [intRaw = '0', fracRaw = ''] = fixed.split('.');
  const intStr = intRaw === '0' ? '' : intRaw;
  const allZero = /^0*$/.test(intRaw) && /^0*$/.test(fracRaw);

  // 整数部: 右から桁の記号に割り当てる。記号より多い桁は最初の記号の前に出す
  const intOut = new Map<number, string>();
  if (grouping) {
    const minDigits = intPlaces.filter((i) => (mantissaTokens[i] as { v?: string }).v === '0').length;
    const padded = intStr.padStart(minDigits, '0');
    const grouped = padded.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    intPlaces.forEach((idx, k) => intOut.set(idx, k === 0 ? grouped : ''));
    if (intPlaces.length > 0 && grouped === '' && (mantissaTokens[intPlaces[intPlaces.length - 1] ?? 0] as { v?: string }).v === '?') {
      intOut.set(intPlaces[0] ?? 0, ' ');
    }
  } else {
    const n = intPlaces.length;
    const extra = intStr.length > n ? intStr.slice(0, intStr.length - n) : '';
    intPlaces.forEach((idx, k) => {
      const digitPos = intStr.length - n + k;
      const t = mantissaTokens[idx] as { v: '0' | '#' | '?' };
      const digit = digitPos >= 0 ? (intStr[digitPos] ?? '') : fill(t.v);
      intOut.set(idx, (k === 0 ? extra : '') + digit);
    });
  }

  // 小数部: 左から。末尾の 0 は # なら消し、? なら空白にする
  const fracOut = new Map<number, string>();
  let lastSignificant = -1;
  for (let k = 0; k < fracRaw.length; k += 1) if (fracRaw[k] !== '0') lastSignificant = k;
  fracPlaces.forEach((idx, k) => {
    const t = mantissaTokens[idx] as { v: '0' | '#' | '?' };
    const digit = fracRaw[k] ?? '0';
    fracOut.set(idx, k <= lastSignificant || t.v === '0' ? digit : fill(t.v));
  });

  let out = '';
  mantissaTokens.forEach((t, i) => {
    if (t.t === 'digit') out += intOut.get(i) ?? fracOut.get(i) ?? '';
    else if (t.t === 'point') out += '.';
    else if (t.t === 'lit') out += t.v;
    else if (t.t === 'percent') out += '%';
    else if (t.t === 'text') out += '';
  });

  if (expIndex >= 0) {
    const expToken = tokens[expIndex] as { sign: '+' | '-' };
    const expDigits = tokens.slice(expIndex + 1).filter((t) => t.t === 'digit').length;
    const sign = exponent < 0 ? '-' : expToken.sign === '+' ? '+' : '';
    out += 'E' + sign + String(Math.abs(exponent)).padStart(Math.max(1, expDigits), '0');
    for (const t of tokens.slice(expIndex + 1)) if (t.t === 'lit') out += t.v;
  }

  // 1 つの節で負の数を書くときは先頭に - を付ける（丸めて 0 になったら付けない）。
  // 桁の記号が無い節（[<0]"負" のような文字だけの節）には付けない
  const hasDigits = intPlaces.length + fracPlaces.length > 0;
  return negative && !allZero && hasDigits ? '-' + out : out;
}

/* ------------------------------------------------------------ 分数 */

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

/** 分母の最大値以下で、x に最も近い分数（連分数）。 */
function approximate(x: number, maxDen: number): [number, number] {
  let bestNum = Math.round(x);
  let bestDen = 1;
  let bestErr = Math.abs(x - bestNum);
  for (let den = 1; den <= maxDen; den += 1) {
    const num = Math.round(x * den);
    const err = Math.abs(x - num / den);
    if (err < bestErr - 1e-12) {
      bestNum = num;
      bestDen = den;
      bestErr = err;
    }
  }
  return [bestNum, bestDen];
}

function renderFraction(spec: FractionSpec, value: number): string {
  const negative = value < 0;
  let x = Math.abs(value);
  let whole = 0;
  if (spec.whole !== '') {
    whole = Math.floor(x);
    x -= whole;
  }
  let num: number;
  let den: number;
  if (spec.fixedDenominator !== null) {
    den = spec.fixedDenominator;
    num = Math.round(x * den);
  } else {
    const maxDen = 10 ** Math.min(4, spec.denominator.length) - 1;
    [num, den] = approximate(x, Math.max(1, maxDen));
    const g = gcd(num, den);
    if (g > 1) {
      num /= g;
      den /= g;
    }
  }
  if (num === den && spec.whole !== '') {
    whole += 1;
    num = 0;
  }
  let body: string;
  if (num === 0 && spec.whole !== '') {
    body = String(whole);
  } else {
    const wholeText = spec.whole !== '' && whole !== 0 ? String(whole) + ' ' : '';
    body = wholeText + String(num).padStart(spec.numerator.length, ' ') + '/' + String(den).padEnd(spec.denominator.length, ' ');
  }
  return (negative ? '-' : '') + spec.prefix + body.trimEnd() + spec.suffix;
}

/* ------------------------------------------------------------ 日時 */

function renderDate(tokens: readonly Token[], serial: number, date1904: boolean): string | null {
  const subsec = tokens.reduce((n, t) => (t.t === 'subsec' ? Math.max(n, t.n) : n), 0);
  const parts = serialToParts(serial, date1904, subsec);
  if (parts === null) return null;
  const twelve = tokens.some((t) => t.t === 'ampm');
  let out = '';
  for (const t of tokens) {
    switch (t.t) {
      case 'lit':
        out += t.v;
        break;
      case 'date':
        out += dateToken(t.v, parts, twelve);
        break;
      case 'elapsed': {
        const unit = t.v === 'h' ? 24 : t.v === 'm' ? 1440 : 86_400;
        const total = Math.floor(serial * unit + 1e-9);
        out += String(total).padStart(t.n, '0');
        break;
      }
      case 'subsec':
        out += t.n === 0 ? '' : '.' + String(Math.round(parts.fraction * 10 ** t.n)).padStart(t.n, '0');
        break;
      case 'ampm': {
        const pm = parts.hour >= 12;
        out += t.v === 'AM/PM' ? (pm ? 'PM' : 'AM') : pm ? 'P' : 'A';
        break;
      }
      case 'digit':
        out += t.v === '0' ? '0' : '';
        break;
      case 'point':
        out += '.';
        break;
      // 日時の形の中の , と % はただの文字（mmmm d, yyyy）
      case 'comma':
        out += ',';
        break;
      case 'percent':
        out += '%';
        break;
      default:
        break;
    }
  }
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function dateToken(v: string, p: DateParts, twelve: boolean): string {
  const hour = twelve ? (p.hour % 12 === 0 ? 12 : p.hour % 12) : p.hour;
  switch (v) {
    case 'y':
    case 'yy':
      return pad2(p.year % 100);
    case 'm':
      return String(p.month);
    case 'mm':
      return pad2(p.month);
    case 'mmm':
      return MONTH_NAMES[p.month - 1]?.slice(0, 3) ?? '';
    case 'mmmmm':
      return MONTH_NAMES[p.month - 1]?.slice(0, 1) ?? '';
    case 'M':
      return String(p.minute);
    case 'MM':
      return pad2(p.minute);
    case 'd':
      return String(p.day);
    case 'dd':
      return pad2(p.day);
    case 'ddd':
      return DAY_NAMES[p.weekday]?.slice(0, 3) ?? '';
    case 'aaa':
      return DAY_NAMES_JA[p.weekday] ?? '';
    case 'aaaa':
      return (DAY_NAMES_JA[p.weekday] ?? '') + '曜日';
    case 'h':
      return String(hour);
    case 'hh':
      return pad2(hour);
    case 's':
      return String(p.second);
    case 'ss':
      return pad2(p.second);
    case 'e':
    case 'ee': {
      const era = eraOf(p);
      const year = era === null ? p.year : era.year;
      return v === 'ee' ? pad2(year) : String(year);
    }
    case 'g':
      return eraOf(p)?.era.letter ?? '';
    case 'gg':
      return eraOf(p)?.era.short ?? '';
    case 'ggg':
      return eraOf(p)?.era.name ?? '';
    default:
      if (v.startsWith('y')) return String(p.year).padStart(4, '0');
      if (v.startsWith('mmmm')) return MONTH_NAMES[p.month - 1] ?? '';
      if (v.startsWith('dddd')) return DAY_NAMES[p.weekday] ?? '';
      if (v.startsWith('ggg')) return eraOf(p)?.era.name ?? '';
      if (v.startsWith('h')) return pad2(hour);
      if (v.startsWith('s')) return pad2(p.second);
      if (v.startsWith('M')) return pad2(p.minute);
      return '';
  }
}
