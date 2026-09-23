/*
 * 行の索引と、1 行の中を見るための低レベルの道具（決定 32）。
 *
 * ここは**文字列を作らない**。返すのはすべてオフセットか数値で、
 * 文字列化は呼び出し側が必要になった時点で行う（F-1）。
 */

/**
 * 行を引くのに要る最小限。`UnityFile` はこれに構造的に代入できるので、
 * パース途中（documents がまだ無い状態）でも同じ関数を使える。
 */
export interface LineView {
  readonly text: string;
  readonly lineStarts: Int32Array;
  readonly lineCount: number;
}

const LF = 10;
const CR = 13;
const SPACE = 32;
const TAB = 9;
const HASH = 35;

export interface LineIndex {
  /** 1 始まり。末尾に番兵として text.length を置く。 */
  readonly lineStarts: Int32Array;
  readonly lineCount: number;
}

/**
 * 行頭オフセットの索引を作る。
 *
 * 2 パスにしてあるのは、1 パス目で行数を数えて `Int32Array` を一度に確保するため。
 * 可変長配列に push すると 200 万行で再確保が繰り返され、ピークヒープが跳ねる。
 */
export function indexLines(text: string): LineIndex {
  let count = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === LF) count += 1;
  }
  // [0] は未使用、[1..count] が各行、[count + 1] が番兵
  const lineStarts = new Int32Array(count + 2);
  lineStarts[1] = 0;
  let line = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === LF) {
      line += 1;
      lineStarts[line] = i + 1;
    }
  }
  lineStarts[count + 1] = text.length;

  // 末尾が改行で終わるテキストでは最後の「空の行」を数えない
  // （`a\n` は 1 行。`a\nb` も 2 行で、どちらも最後の行に中身がある形に揃える）
  const lastStart = lineStarts[count] ?? 0;
  const lineCount = count > 1 && lastStart >= text.length ? count - 1 : count;
  return { lineStarts, lineCount };
}

/** その行の先頭オフセット。範囲外は text.length を返す。 */
export function lineStart(file: LineView, lineNo: number): number {
  if (lineNo < 1 || lineNo > file.lineCount) return file.text.length;
  return file.lineStarts[lineNo] ?? file.text.length;
}

/** その行の終端オフセット（CR / LF を含まない）。 */
export function lineEnd(file: LineView, lineNo: number): number {
  if (lineNo < 1 || lineNo > file.lineCount) return file.text.length;
  const next = file.lineStarts[lineNo + 1] ?? file.text.length;
  let end = next;
  if (end > 0 && file.text.charCodeAt(end - 1) === LF) end -= 1;
  if (end > 0 && file.text.charCodeAt(end - 1) === CR) end -= 1;
  return end;
}

/**
 * 行の本文（CR / LF を含まない）。
 *
 * **CR を落とすのは値の比較用**であって、行番号は落とさない。
 * CRLF と LF の食い違いは diff との突き合わせで別途扱う（決定 32 / F-6）。
 */
export function lineText(file: LineView, lineNo: number): string {
  return file.text.slice(lineStart(file, lineNo), lineEnd(file, lineNo));
}

/** 行頭の空白の数。空行・コメント行では -1 を返す（「中身が無い」の意）。 */
export function indentOf(file: LineView, lineNo: number): number {
  const start = lineStart(file, lineNo);
  const end = lineEnd(file, lineNo);
  let i = start;
  while (i < end) {
    const c = file.text.charCodeAt(i);
    if (c !== SPACE && c !== TAB) break;
    i += 1;
  }
  if (i >= end) return -1;
  if (file.text.charCodeAt(i) === HASH) return -1;
  return i - start;
}

/** その行に中身があるか（空行・コメント行でない）。 */
export function hasContent(file: LineView, lineNo: number): boolean {
  return indentOf(file, lineNo) >= 0;
}

/**
 * `key:` を終わらせるコロンの位置を返す。見つからなければ -1。
 *
 * 引用符の中とフロー（`{}` / `[]`）の中のコロンは飛ばす。
 * 「コロンの直後が空白か行末」であることを条件にするのは YAML の規則どおりで、
 * `m_Name: a:b` の `a:b` を誤ってキーの区切りにしないため。
 */
export function findKeyColon(text: string, from: number, end: number): number {
  let depth = 0;
  let i = from;
  while (i < end) {
    const c = text[i];
    if (c === "'" || c === '"') {
      i = skipQuoted(text, i, end);
      continue;
    }
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') depth -= 1;
    else if (c === ':' && depth === 0) {
      const next = i + 1;
      if (next >= end || text.charCodeAt(next) === SPACE || text.charCodeAt(next) === TAB) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * 引用符で始まる位置から、閉じ引用符の**次**の位置を返す。
 * 閉じていなければ end を返す（壊れた行でも無限ループにしない）。
 */
export function skipQuoted(text: string, from: number, end: number): number {
  const quote = text[from];
  let i = from + 1;
  while (i < end) {
    const c = text[i];
    if (quote === "'" && c === "'") {
      // '' は単一の ' を表すエスケープ。閉じではない
      if (i + 1 < end && text[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    if (quote === '"') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') return i + 1;
    }
    i += 1;
  }
  return end;
}

/** 前後の空白を落とした範囲を返す。 */
export function trimRange(text: string, from: number, end: number): { start: number; stop: number } {
  let start = from;
  let stop = end;
  while (start < stop) {
    const c = text.charCodeAt(start);
    if (c !== SPACE && c !== TAB) break;
    start += 1;
  }
  while (stop > start) {
    const c = text.charCodeAt(stop - 1);
    if (c !== SPACE && c !== TAB) break;
    stop -= 1;
  }
  return { start, stop };
}
