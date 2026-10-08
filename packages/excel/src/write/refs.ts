/*
 * 行の挿入・削除に伴う参照の付け替え（docs/07-xlsx-cell-merge.md 5.1〜5.2）。
 *
 * 「古い行 → 新しい行」の対応（RowMap）は単調なので、Excel が行を挿入・削除したときと同じ結果を
 * 1 つの規則で出せる:
 *   - セル `A5`: 新しい行へ。`$` の有無を問わない（構造の変更なので）。消えた行なら `#REF!`
 *   - 範囲 `A2:B9`・行全体 `3:7`: 両端を付け替える。端が消えていれば内側に残った行へ寄せる。全部消えたら `#REF!`
 *   - 列全体 `A:C`・構造化参照・外部ブックの参照: 変えない
 *   - 3D 参照（`Sheet1:Sheet3!A1`）: 行を変えたシートがあるブックでは扱えないので投げる
 *
 * 字句の読み方（文字列・引用符付きのシート名・角括弧を飛ばす）は共有数式のずらし（formula/shared.ts）と揃える。
 */

import { MAX_ROWS } from '../sheet/ref.js';
import {
  endsReference,
  isDigit,
  isLetter,
  isNameChar,
  readColumn,
  readRow,
  rowText,
  skipBrackets,
  skipQuoted,
  type Part,
} from '../formula/shared.js';

export interface RowMap {
  readonly identity: boolean;
  /** 0 始まりの行 → 新しい行。消えた行・シートの外へ出た行は null。 */
  point(row: number): number | null;
  /** 両端を含む [r1, r2]（r1 <= r2）→ 新しい範囲。全部消えたら null。 */
  range(r1: number, r2: number): readonly [number, number] | null;
}

export const IDENTITY_MAP: RowMap = {
  identity: true,
  point: (row) => row,
  range: (r1, r2) => [r1, r2],
};

/**
 * 対応表から RowMap を作る。`newIndex[r]` は古い行 r の新しい行（消えたら -1）。
 * 表より下の行は `tailShift` だけずらす（最終行より下の空き行）。
 */
export function buildRowMap(newIndex: Int32Array, tailShift: number): RowMap {
  const n = newIndex.length;
  let identity = tailShift === 0;
  for (let r = 0; r < n && identity; r += 1) if (newIndex[r] !== r) identity = false;
  if (identity) return IDENTITY_MAP;

  // 次に残る行・前に残る行（表の外は全部残る）
  const nextKept = new Int32Array(n + 1);
  nextKept[n] = n;
  for (let r = n - 1; r >= 0; r -= 1) nextKept[r] = (newIndex[r] ?? -1) >= 0 ? r : (nextKept[r + 1] ?? n);
  const prevKept = new Int32Array(n);
  for (let r = 0; r < n; r += 1) prevKept[r] = (newIndex[r] ?? -1) >= 0 ? r : r > 0 ? (prevKept[r - 1] ?? -1) : -1;

  const raw = (row: number): number => (row < n ? (newIndex[row] ?? -1) : row + tailShift);
  const valid = (v: number): number | null => (v >= 0 && v < MAX_ROWS ? v : null);

  return {
    identity: false,
    point: (row) => {
      const v = raw(row);
      return v < 0 ? null : valid(v);
    },
    range: (r1, r2) => {
      const first = r1 < n ? (nextKept[r1] ?? n) : r1;
      const last = r2 < n ? (prevKept[r2] ?? -1) : r2;
      if (first > r2 || last < r1 || last < first) return null;
      const a = raw(first);
      // 範囲の終わりがシートの外へ押し出されたら、最終行で止める（A1:A1048576 の形を保つ）
      const b = Math.min(MAX_ROWS - 1, raw(last));
      if (a < 0 || a >= MAX_ROWS || b < a) return null;
      return [a, b];
    },
  };
}

/** 3D 参照など、付け替えられない参照があった。 */
export class UnsupportedReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedReferenceError';
  }
}

export interface FormulaContext {
  /** 数式のあるシートの名前（修飾の無い参照の行き先）。ブック単位の数式（名前の定義・グラフ）なら null。 */
  readonly sheet: string | null;
  /** シートの対応。行を変えていないシートは null（または identity）。名前は大文字小文字を区別しない。 */
  map(sheetName: string): RowMap | null;
  /** 行を変えたシートが 1 つでもあるか（3D 参照を断るため）。 */
  readonly anyChanged: boolean;
  /**
   * シート名の付け替え（相手側の数式を土台へ写すとき）。undefined なら同じ名前のまま、文字列ならその名前へ、
   * null なら土台に無いシート（参照を写せないので投げる）。
   */
  renameSheet?(sheetName: string): string | null | undefined;
}

/** シート名の修飾（`'名前'!`）。引用符は常に付ける（Excel は付いていても読む）。 */
function quotedSheet(name: string): string {
  return "'" + name.replace(/'/g, "''") + "'!";
}

/** 修飾の本文。付け替えが無ければ元のまま（original は `!` 込み）。 */
function prefixText(ctx: FormulaContext, name: string, original: string): string {
  if (ctx.renameSheet === undefined) return original;
  const renamed = ctx.renameSheet(name);
  if (renamed === null) throw new UnsupportedReferenceError('土台のブックに無いシート（' + name + '）を参照しています。');
  return renamed === undefined || renamed === name ? original : quotedSheet(renamed);
}

export interface RemapResult {
  readonly text: string;
  /** 行を変えたシートへの参照を含んでいたか（共有数式を展開するかの判定）。 */
  readonly touched: boolean;
}

function changedMap(ctx: FormulaContext, sheet: string | null): RowMap | null {
  if (sheet === null) return null;
  const m = ctx.map(sheet);
  return m === null || m.identity ? null : m;
}

/** 引用符付きの名前の中身（`''` → `'`）。 */
function unquote(s: string, start: number, end: number): string {
  return s.slice(start + 1, end - 1).replace(/''/g, "'");
}

interface Ref {
  readonly end: number;
  /** 付け替えた本文（付け替えない参照なら元の本文）。 */
  readonly text: string;
}

/**
 * at から参照（セル・範囲・行全体・列全体）を読み、map で付け替える。参照でなければ null。
 * map が null なら付け替えずに元の本文を返す（参照の長さを知るためだけに読む）。
 */
function readRef(s: string, at: number, map: RowMap | null): Ref | null {
  const colA = readColumn(s, at);
  if (colA !== null) {
    // 列全体 A:C（行が無いので変えない）
    if (s.charCodeAt(colA.end) === 58) {
      const colB = readColumn(s, colA.end + 1);
      if (colB !== null && endsReference(s, colB.end)) return { end: colB.end, text: s.slice(at, colB.end) };
    }
    const rowA = readRow(s, colA.end);
    if (rowA === null) return null;
    // 範囲 A1:B2
    if (s.charCodeAt(rowA.end) === 58) {
      const colB = readColumn(s, rowA.end + 1);
      const rowB = colB === null ? null : readRow(s, colB.end);
      if (colB !== null && rowB !== null && endsReference(s, rowB.end)) {
        const text =
          map === null
            ? s.slice(at, rowB.end)
            : rangeText(map, rowA, rowB, s.slice(at, colA.end), s.slice(rowA.end + 1, colB.end));
        return { end: rowB.end, text };
      }
    }
    if (!endsReference(s, rowA.end)) return null;
    if (map === null) return { end: rowA.end, text: s.slice(at, rowA.end) };
    const r = map.point(rowA.value);
    return { end: rowA.end, text: r === null ? '#REF!' : s.slice(at, colA.end) + rowText(r, rowA.absolute) };
  }
  // 行全体 1:3
  const rowA = readRow(s, at);
  if (rowA !== null && s.charCodeAt(rowA.end) === 58) {
    const rowB = readRow(s, rowA.end + 1);
    if (rowB !== null && endsReference(s, rowB.end) && s.charCodeAt(rowB.end) !== 46) {
      if (map === null) return { end: rowB.end, text: s.slice(at, rowB.end) };
      return { end: rowB.end, text: rangeText(map, rowA, rowB, '', '') };
    }
  }
  return null;
}

function rangeText(map: RowMap, a: Part, b: Part, colA: string, colB: string): string {
  const reversed = a.value > b.value;
  const lo = reversed ? b : a;
  const hi = reversed ? a : b;
  const r = map.range(lo.value, hi.value);
  if (r === null) return '#REF!';
  const [nl, nh] = r;
  const first = reversed ? nh : nl;
  const second = reversed ? nl : nh;
  return colA + rowText(first, a.absolute) + ':' + colB + rowText(second, b.absolute);
}

export function remapFormula(formula: string, ctx: FormulaContext): RemapResult {
  const s = formula;
  let out = '';
  let touched = false;
  let i = 0;

  /** prefix（シートの修飾）の直後 at から参照を読んで出す。参照でなければ何もしない。 */
  const emitRef = (at: number, sheet: string | null): number => {
    const map = changedMap(ctx, sheet);
    const ref = readRef(s, at, map);
    if (ref === null) return at;
    if (map !== null) touched = true;
    out += ref.text;
    return ref.end;
  };

  while (i < s.length) {
    const c = s.charCodeAt(i);
    const prev = i > 0 ? s.charCodeAt(i - 1) : 0;
    const startsToken = i === 0 || !isNameChar(prev);

    if (c === 34) {
      const end = skipQuoted(s, i, 34);
      out += s.slice(i, end);
      i = end;
      continue;
    }

    // 外部ブック [1]Sheet1!A1 は丸ごと写す。構造化参照 Table1[列] は角括弧だけ写す
    if (c === 91) {
      const end = skipBrackets(s, i);
      out += s.slice(i, end);
      i = end;
      if (startsToken) i = copyExternalTail(s, i, (t) => (out += t));
      continue;
    }

    if (c === 39) {
      const end = skipQuoted(s, i, 39);
      if (s.charCodeAt(end) === 33 /* ! */) {
        const name = unquote(s, i, end);
        if (name.startsWith('[')) {
          out += s.slice(i, end + 1);
          i = copyRefVerbatim(s, end + 1, (t) => (out += t));
          continue;
        }
        if (name.includes(':')) {
          out += s.slice(i, end + 1);
          if (ctx.anyChanged) throw new UnsupportedReferenceError('3D 参照（' + s.slice(i, end + 1) + '）は行の挿入・削除と一緒に扱えません。');
          i = copyRefVerbatim(s, end + 1, (t) => (out += t));
          continue;
        }
        out += prefixText(ctx, name, s.slice(i, end + 1));
        i = emitRef(end + 1, name);
        continue;
      }
      out += s.slice(i, end);
      i = end;
      continue;
    }

    if (startsToken && (isLetter(c) || isDigit(c) || c === 36 || c === 95 || c === 92 || c >= 0x80)) {
      // 名前の並び（シート名・関数名・定義名・参照）
      let j = i + (c === 36 ? 1 : 0);
      while (j < s.length && isNameChar(s.charCodeAt(j))) j += 1;
      if (s.charCodeAt(j) === 33 && c !== 36) {
        const name = s.slice(i, j);
        out += prefixText(ctx, name, s.slice(i, j + 1));
        i = emitRef(j + 1, name);
        continue;
      }
      if (s.charCodeAt(j) === 58 && c !== 36) {
        let k = j + 1;
        while (k < s.length && isNameChar(s.charCodeAt(k))) k += 1;
        if (k > j + 1 && s.charCodeAt(k) === 33) {
          if (ctx.anyChanged) throw new UnsupportedReferenceError('3D 参照（' + s.slice(i, k + 1) + '）は行の挿入・削除と一緒に扱えません。');
          out += s.slice(i, k + 1);
          i = copyRefVerbatim(s, k + 1, (t) => (out += t));
          continue;
        }
      }
      const next = emitRef(i, ctx.sheet);
      if (next !== i) {
        i = next;
        continue;
      }
      if (j === i) j = i + 1;
      out += s.slice(i, j);
      i = j;
      continue;
    }

    out += s[i] ?? '';
    i += 1;
  }
  return { text: out, touched };
}

/** 外部ブックの番号の後ろ（`Sheet1!A1` や `'a b'!A1`）を写す。 */
function copyExternalTail(s: string, at: number, emit: (t: string) => void): number {
  let i = at;
  if (s.charCodeAt(i) === 39) {
    const end = skipQuoted(s, i, 39);
    emit(s.slice(i, end));
    i = end;
  } else {
    let j = i;
    while (j < s.length && isNameChar(s.charCodeAt(j))) j += 1;
    emit(s.slice(i, j));
    i = j;
  }
  if (s.charCodeAt(i) !== 33) return i;
  emit('!');
  return copyRefVerbatim(s, i + 1, emit);
}

/** 参照の形の並び（`$` 英数字 `:`）をそのまま写す。 */
function copyRefVerbatim(s: string, at: number, emit: (t: string) => void): number {
  let j = at;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 36 || c === 58 || isLetter(c) || isDigit(c)) j += 1;
    else break;
  }
  emit(s.slice(at, j));
  return j;
}

/** 修飾の無い参照 1 つ（`A1` / `A1:B2` / 行全体 / 列全体）を付け替える。全部消えたら null。 */
export function remapRefText(text: string, map: RowMap): string | null {
  if (map.identity) return text;
  const t = text.trim();
  const ref = readRef(t, 0, map);
  if (ref === null || ref.end !== t.length) return text;
  return ref.text === '#REF!' ? null : ref.text;
}

/** 空白区切りの範囲の並び（sqref）。消えた範囲は落とす。全部消えたら null。 */
export function remapSqref(text: string, map: RowMap): string | null {
  if (map.identity) return text;
  const items = text.split(/\s+/).filter((x) => x.length > 0);
  const out: string[] = [];
  for (const item of items) {
    const r = remapRefText(item, map);
    if (r !== null) out.push(r);
  }
  return out.length === 0 ? null : out.join(' ');
}
