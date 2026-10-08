/*
 * 共有数式の参照ずらし（決定 33）。
 *
 * Excel は同じ形の数式が縦横に並ぶとき、先頭のセルにだけ式を書き（`<f t="shared" si="0" ref="B2:B9">A2*2</f>`）、
 * 残りのセルには `<f t="shared" si="0"/>` しか書かない。残りのセルの式は、先頭の式の**相対参照**を
 * 位置の差だけずらして作る（`$` の付いた絶対参照はずらさない）。
 *
 * 正規表現は使わず 1 文字ずつ読む（文字列リテラル・引用符付きシート名・構造化参照の角括弧の中を
 * 確実に飛ばすため。CLAUDE.md の「ヒアドキュメントでバックスラッシュが縮む」癖も踏まない）。
 *
 * 扱う参照: `A1` / `$A$1` / `A1:B2`（両端を個別に）/ 列全体 `A:C` / 行全体 `1:3`、シート修飾 `Sheet1!A1` / `'a b'!A1`。
 * ずらした結果がシートの外に出た参照は `#REF!` にする（Excel と同じ）。
 */

import { MAX_COLS, MAX_ROWS } from '../sheet/ref.js';

export function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

export function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** 名前（関数名・定義名・シート名）の一部になりうる文字。直前がこれなら参照の始まりではない。 */
export function isNameChar(c: number): boolean {
  return isLetter(c) || isDigit(c) || c === 95 /* _ */ || c === 46 /* . */ || c === 92 /* \ */ || c === 63 /* ? */ || c >= 0x80;
}

export interface Part {
  /** 読み終えた位置。 */
  readonly end: number;
  readonly absolute: boolean;
  readonly value: number;
}

/** `$?[A-Za-z]{1,3}` を読む。value は 0 始まりの列番号。 */
export function readColumn(s: string, at: number): Part | null {
  let i = at;
  const absolute = s.charCodeAt(i) === 36;
  if (absolute) i += 1;
  let col = 0;
  let n = 0;
  while (i < s.length && isLetter(s.charCodeAt(i))) {
    const c = s.charCodeAt(i) & ~0x20;
    col = col * 26 + (c - 64);
    n += 1;
    if (n > 3) return null;
    i += 1;
  }
  if (n === 0 || col > MAX_COLS) return null;
  return { end: i, absolute, value: col - 1 };
}

/** `$?[0-9]{1,7}` を読む。value は 0 始まりの行番号。 */
export function readRow(s: string, at: number): Part | null {
  let i = at;
  const absolute = s.charCodeAt(i) === 36;
  if (absolute) i += 1;
  let row = 0;
  let n = 0;
  while (i < s.length && isDigit(s.charCodeAt(i))) {
    row = row * 10 + (s.charCodeAt(i) - 48);
    n += 1;
    if (n > 7) return null;
    i += 1;
  }
  if (n === 0 || row < 1 || row > MAX_ROWS) return null;
  return { end: i, absolute, value: row - 1 };
}

export function colText(col: number, absolute: boolean): string {
  let n = col + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return (absolute ? '$' : '') + out;
}

export function rowText(row: number, absolute: boolean): string {
  return (absolute ? '$' : '') + String(row + 1);
}

/** 参照の終わりの直後として正しいか（名前の途中・関数呼び出し・シート名でない）。 */
export function endsReference(s: string, at: number): boolean {
  if (at >= s.length) return true;
  const c = s.charCodeAt(at);
  if (isNameChar(c)) return false;
  // `LOG10(` のような関数名、`AB1!` のようなシート名
  return c !== 40 /* ( */ && c !== 33; /* ! */
}

/** 行・列をずらす。はみ出したら null。 */
function shift(part: Part, delta: number, max: number): number | null {
  if (part.absolute) return part.value;
  const v = part.value + delta;
  return v < 0 || v >= max ? null : v;
}

export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  if (dRow === 0 && dCol === 0) return formula;
  const s = formula;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);

    // 文字列リテラル（"" は " の逃がし）
    if (c === 34) {
      const end = skipQuoted(s, i, 34);
      out += s.slice(i, end);
      i = end;
      continue;
    }
    // 引用符付きのシート名（'' は ' の逃がし）
    if (c === 39) {
      const end = skipQuoted(s, i, 39);
      out += s.slice(i, end);
      i = end;
      continue;
    }
    // 構造化参照・外部ブック番号の角括弧（入れ子あり）
    if (c === 91) {
      const end = skipBrackets(s, i);
      out += s.slice(i, end);
      i = end;
      continue;
    }

    const prev = i > 0 ? s.charCodeAt(i - 1) : 0;
    const startsToken = i === 0 || !isNameChar(prev);

    if (startsToken && (isLetter(c) || c === 36 || isDigit(c))) {
      const replaced = tryReference(s, i, dRow, dCol);
      if (replaced !== null) {
        out += replaced.text;
        i = replaced.end;
        continue;
      }
      // 参照でなければ、名前（や数値）を丸ごと写す。途中から参照を探し直さない
      let j = i + (c === 36 ? 1 : 0);
      while (j < s.length && isNameChar(s.charCodeAt(j))) j += 1;
      if (j === i) j = i + 1;
      out += s.slice(i, j);
      i = j;
      continue;
    }

    out += s[i] ?? '';
    i += 1;
  }
  return out;
}

interface Replaced {
  readonly text: string;
  readonly end: number;
}

function tryReference(s: string, at: number, dRow: number, dCol: number): Replaced | null {
  // 列全体 A:C
  const colA = readColumn(s, at);
  if (colA !== null && s.charCodeAt(colA.end) === 58 /* : */) {
    const colB = readColumn(s, colA.end + 1);
    if (colB !== null && endsReference(s, colB.end)) {
      const a = shift(colA, dCol, MAX_COLS);
      const b = shift(colB, dCol, MAX_COLS);
      const text = a === null || b === null ? '#REF!' : colText(a, colA.absolute) + ':' + colText(b, colB.absolute);
      return { text, end: colB.end };
    }
  }
  // セル A1
  if (colA !== null) {
    const row = readRow(s, colA.end);
    if (row !== null && endsReference(s, row.end)) {
      const r = shift(row, dRow, MAX_ROWS);
      const cc = shift(colA, dCol, MAX_COLS);
      const text = r === null || cc === null ? '#REF!' : colText(cc, colA.absolute) + rowText(r, row.absolute);
      return { text, end: row.end };
    }
    return null;
  }
  // 行全体 1:3（直前が数値の一部でないことは startsToken で保証済み）
  const rowA = readRow(s, at);
  if (rowA !== null && s.charCodeAt(rowA.end) === 58) {
    const rowB = readRow(s, rowA.end + 1);
    if (rowB !== null && endsReference(s, rowB.end) && s.charCodeAt(rowB.end) !== 46) {
      const a = shift(rowA, dRow, MAX_ROWS);
      const b = shift(rowB, dRow, MAX_ROWS);
      const text = a === null || b === null ? '#REF!' : rowText(a, rowA.absolute) + ':' + rowText(b, rowB.absolute);
      return { text, end: rowB.end };
    }
  }
  return null;
}

/** 引用符で始まる区間の終わり（閉じ引用符の直後）。二重の引用符は逃がし。閉じていなければ末尾。 */
export function skipQuoted(s: string, at: number, quote: number): number {
  let i = at + 1;
  while (i < s.length) {
    if (s.charCodeAt(i) === quote) {
      if (s.charCodeAt(i + 1) === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return s.length;
}

export function skipBrackets(s: string, at: number): number {
  let depth = 0;
  let i = at;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 91) depth += 1;
    else if (c === 93) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return s.length;
}
