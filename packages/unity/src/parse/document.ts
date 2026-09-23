/*
 * Unity の YAML をドキュメントの並びとして読む（決定 32）。
 *
 * 汎用の YAML パーサではなく、**Unity が書き出す部分集合だけ**を読む。
 * 扱うのは次のもの:
 *   - ディレクティブ `%YAML 1.1` / `%TAG !u! tag:unity3d.com,2011:`
 *   - ドキュメント頭 `--- !u!<classId> &<anchor> [stripped]`
 *   - ブロックマッピング / ブロックシーケンス（`- ` のコンパクト表記を含む）
 *   - フローマッピング `{fileID: 0}` / フローシーケンス `[]`
 *   - 引用符つきスカラ（`'...'` と `"..."`）、ブロックスカラ（`|` / `>`）
 *   - **重複キー**（捨てずに全部持つ。表示側で `key #2` のように区別する）
 *
 * ドキュメント本体の最上位キー（`GameObject:` / `Transform:` / `MonoBehaviour:`）が
 * そのままクラス名になるので、**クラス ID から名前を引く表を持たずに済む**。
 * Unity のバージョンが上がって新しいクラスが増えても追いかけなくてよい。
 *
 * 壊れた入力でも**例外を投げず、読めたところまでを返す**。ここで投げると
 * 「差分が見られない」ではなく「アプリが落ちる」になってしまう。
 */

import type {
  ScalarStyle,
  UnityDocument,
  UnityEntry,
  UnityFile,
  UnityMapping,
  UnityScalar,
  UnitySequence,
  UnityValue,
} from '../model/types.js';
import {
  findKeyColon,
  indentOf,
  indexLines,
  type LineView,
  lineEnd,
  lineStart,
  trimRange,
} from './lexer.js';

const SPACE = 32;
const TAB = 9;
const DASH = 45;

/** パース結果と、次に読むべき行。 */
interface Parsed<T> {
  readonly value: T;
  readonly next: number;
}

/**
 * Unity の YAML として読めそうか。
 *
 * Asset Serialization Mode が Force Binary / Mixed のプロジェクトと、
 * LFS のポインタ（`version https://git-lfs...`）がここで落ちる。
 * どちらも「展開できないので通常の扱いに戻す」で正しい（決定 32）。
 */
export function isUnityYaml(text: string): boolean {
  let head = text;
  // UTF-8 BOM。Unity は付けないが、他のツールが通ったファイルで見かける
  if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
  return head.startsWith('%YAML');
}

export function parseUnityFile(text: string): UnityFile {
  const { lineStarts, lineCount } = indexLines(text);
  const view: LineView = { text, lineStarts, lineCount };

  // 1 パス目: ドキュメント頭の行番号を集める。
  // 先に全部集めることで各ドキュメントの終端が「次の頭の 1 つ前」で決まり、
  // 本体のパースが後戻りしなくて済む
  const headers: number[] = [];
  for (let i = 1; i <= lineCount; i += 1) {
    if (isDocumentHeader(view, i)) headers.push(i);
  }

  const documents: UnityDocument[] = [];
  const byAnchor = new Map<string, UnityDocument>();
  for (let h = 0; h < headers.length; h += 1) {
    const headerLine = headers[h];
    if (headerLine === undefined) continue;
    const nextHeader = headers[h + 1];
    const limit = (nextHeader === undefined ? lineCount + 1 : nextHeader) - 1;
    const doc = parseDocument(view, headerLine, limit);
    documents.push(doc);
    if (doc.anchor !== '' && !byAnchor.has(doc.anchor)) byAnchor.set(doc.anchor, doc);
  }

  return { text, lineStarts, lineCount, documents, byAnchor };
}

/* ------------------------------------------------------------------ ドキュメント */

function isDocumentHeader(view: LineView, lineNo: number): boolean {
  const start = lineStart(view, lineNo);
  const end = lineEnd(view, lineNo);
  return end - start >= 3 && view.text.startsWith('---', start);
}

/**
 * ドキュメント頭を読む。
 *
 * 正規表現を使わずトークンを手で拾うのは、シェル経由でソースを書くときに
 * バックスラッシュが縮む事故（CLAUDE.md「この環境の癖」4）を避けるため。
 * 形も単純なので、手で読むほうが挙動が目に見える。
 */
function parseDocument(view: LineView, headerLine: number, limit: number): UnityDocument {
  const { text } = view;
  const end = lineEnd(view, headerLine);
  let i = lineStart(view, headerLine) + 3;

  let classId = 0;
  let anchor = '';
  let stripped = false;

  while (i < end) {
    const c = text.charCodeAt(i);
    if (c === SPACE || c === TAB) {
      i += 1;
      continue;
    }
    const tokenStart = i;
    while (i < end) {
      const t = text.charCodeAt(i);
      if (t === SPACE || t === TAB) break;
      i += 1;
    }
    const token = text.slice(tokenStart, i);
    if (token.startsWith('!u!')) {
      const parsed = Number.parseInt(token.slice(3), 10);
      if (Number.isFinite(parsed)) classId = parsed;
    } else if (token.startsWith('&')) {
      anchor = token.slice(1);
    } else if (token === 'stripped') {
      stripped = true;
    }
  }

  // 最上位キー（クラス名）だけを読む。
  // **本体はここではパースしない**——全ドキュメントの本体をオブジェクトにすると
  // 50MB のシーンでヒープが元の 6.5 倍になった（M1 の実測）。
  // 中身が要るのは利用者が選んだ 1 ドキュメントだけなので `documentBody` に任せる
  let typeName = '';
  let bodyStartLine = 0;
  let bodyIndent = 0;

  const first = nextContentLine(view, headerLine + 1, limit);
  if (first !== 0) {
    const indent = indentOf(view, first);
    const from = lineStart(view, first) + indent;
    const to = lineEnd(view, first);
    const colon = findKeyColon(text, from, to);
    if (colon >= 0) {
      typeName = text.slice(from, colon);
      const bodyLine = nextContentLine(view, first + 1, limit);
      if (bodyLine !== 0 && indentOf(view, bodyLine) > indent) {
        bodyStartLine = bodyLine;
        bodyIndent = indentOf(view, bodyLine);
      }
    }
  }

  return {
    anchor,
    classId,
    stripped,
    typeName,
    startLine: headerLine,
    endLine: limit,
    bodyStartLine,
    bodyIndent,
  };
}

/**
 * そのドキュメントの本体を今すぐパースする。
 *
 * **呼ぶのは「利用者が選んだ 1 ノードの表を作るとき」だけ。** 結果は保持しない
 * （保持すると遅延にした意味が消える。F-1）。1 ドキュメントは数十行なので毎回作ってよい。
 */
export function documentBody(file: UnityFile, doc: UnityDocument): UnityMapping {
  if (doc.bodyStartLine === 0) {
    return emptyMapping(doc.startLine, lineEnd(file, doc.startLine));
  }
  const startCol = lineStart(file, doc.bodyStartLine) + doc.bodyIndent;
  return parseMappingAt(file, doc.bodyStartLine, startCol, doc.bodyIndent, doc.endLine).value;
}

/**
 * 本体の最上位キーを 1 つだけ探す。
 *
 * ヒエラルキーの組み立てで要るのは `m_GameObject` / `m_Father` / `m_Children` /
 * `m_Component` / `m_Name` / `m_Modification` くらいなので、
 * **全ドキュメントに走らせても安い**この口を使う（`documentBody` は使わない）。
 */
export function scanDocumentKey(
  file: UnityFile,
  doc: UnityDocument,
  key: string,
): UnityValue | null {
  if (doc.bodyStartLine === 0) return null;
  const { text } = file;

  for (let i = doc.bodyStartLine; i <= doc.endLine; i += 1) {
    const ind = indentOf(file, i);
    if (ind < 0) continue;
    // 本体の最上位（= bodyIndent）だけを見る。深い階層の同名キーは拾わない
    if (ind < doc.bodyIndent) break;
    if (ind > doc.bodyIndent) continue;
    if (startsWithDash(file, i, ind)) continue;

    const from = lineStart(file, i) + ind;
    const to = lineEnd(file, i);
    if (!text.startsWith(key, from)) continue;
    if (text[from + key.length] !== ':') continue;

    const rest = trimRange(text, from + key.length + 1, to);
    if (rest.start >= rest.stop) {
      return parseBlockAfterKey(file, i, ind, doc.endLine).value;
    }
    if (isBlockScalarIndicator(text, rest.start, rest.stop)) {
      return parseBlockScalar(file, i, ind, doc.endLine).value;
    }
    return parseInline(text, rest.start, rest.stop, i).value;
  }
  return null;
}

/* ------------------------------------------------------------------ ブロック */

/**
 * `key:` の値が行に無かったときに、続く行から値を読む。
 *
 * **シーケンスはキーと同じインデントに来る**ことに注意（Unity はこう書く）:
 * ```
 * m_Children:
 * - {fileID: 123}
 * ```
 * 深いインデントで来る形（`m_Modifications:` の下の `  - target:`）もあるので、
 * 「キーより深い」か「キーと同じでハイフン始まり」の両方を値として受け取る。
 */
function parseBlockAfterKey(
  view: LineView,
  keyLine: number,
  keyIndent: number,
  limit: number,
): Parsed<UnityValue> {
  const j = nextContentLine(view, keyLine + 1, limit);
  if (j === 0) return { value: emptyScalar(keyLine, lineEnd(view, keyLine)), next: keyLine + 1 };

  const indent = indentOf(view, j);
  if (indent > keyIndent) return parseBlock(view, j, indent, limit);
  if (indent === keyIndent && startsWithDash(view, j, indent)) {
    return parseSequence(view, j, indent, limit);
  }
  return { value: emptyScalar(keyLine, lineEnd(view, keyLine)), next: keyLine + 1 };
}

function parseBlock(view: LineView, start: number, indent: number, limit: number): Parsed<UnityValue> {
  if (startsWithDash(view, start, indent)) return parseSequence(view, start, indent, limit);
  return parseMappingAt(view, start, lineStart(view, start) + indent, indent, limit);
}

/**
 * ブロックマッピングを読む。
 *
 * `startCol` を取るのは、シーケンスのコンパクト表記（`- target: {...}`）で
 * **1 行目だけハイフンの分だけ字下げが浅い**ためで、
 * 2 行目以降は `indent` ちょうどを要求する。
 */
function parseMappingAt(
  view: LineView,
  startLine: number,
  startCol: number,
  indent: number,
  limit: number,
): Parsed<UnityMapping> {
  const { text } = view;
  const entries: UnityEntry[] = [];
  let i = startLine;
  let endLine = startLine;
  let spanEnd = lineEnd(view, startLine);

  while (i <= limit) {
    const ind = indentOf(view, i);
    if (ind < 0) {
      i += 1;
      continue;
    }
    const first = i === startLine;
    if (!first) {
      if (ind !== indent) break;
      if (startsWithDash(view, i, ind)) break;
    }

    const from = first ? startCol : lineStart(view, i) + ind;
    const to = lineEnd(view, i);
    const colon = findKeyColon(text, from, to);
    if (colon < 0) break;

    const key = text.slice(from, colon);
    const rest = trimRange(text, colon + 1, to);
    const keyLine = i;

    let value: UnityValue;
    if (rest.start >= rest.stop) {
      const parsed = parseBlockAfterKey(view, i, ind, limit);
      value = parsed.value;
      i = parsed.next;
    } else if (isBlockScalarIndicator(text, rest.start, rest.stop)) {
      const parsed = parseBlockScalar(view, i, ind, limit);
      value = parsed.value;
      i = parsed.next;
    } else {
      value = parseInline(text, rest.start, rest.stop, i).value;
      i += 1;
    }

    entries.push({ key, keyLine, value });
    endLine = Math.max(endLine, valueEndLine(value, keyLine));
    spanEnd = Math.max(spanEnd, lineEnd(view, endLine));
  }

  return {
    value: {
      kind: 'mapping',
      startLine,
      endLine,
      offset: startCol,
      length: Math.max(0, spanEnd - startCol),
      entries,
      flow: false,
    },
    next: i,
  };
}

function parseSequence(
  view: LineView,
  start: number,
  indent: number,
  limit: number,
): Parsed<UnitySequence> {
  const { text } = view;
  const items: UnityValue[] = [];
  let i = start;
  let endLine = start;
  let spanEnd = lineEnd(view, start);

  while (i <= limit) {
    const ind = indentOf(view, i);
    if (ind < 0) {
      i += 1;
      continue;
    }
    if (ind !== indent || !startsWithDash(view, i, ind)) break;

    const dashPos = lineStart(view, i) + ind;
    const to = lineEnd(view, i);
    const rest = trimRange(text, dashPos + 1, to);
    const itemLine = i;

    let item: UnityValue;
    if (rest.start >= rest.stop) {
      // `-` 単独。要素は次の行以降のブロック
      const parsed = parseBlockAfterKey(view, i, ind, limit);
      item = parsed.value;
      i = parsed.next;
    } else if (findKeyColon(text, rest.start, rest.stop) >= 0) {
      // コンパクト表記 `- key: value`。この行から始まるマッピングで、
      // 2 行目以降はハイフンの分だけ深い位置（= rest.start の桁）に並ぶ
      const childIndent = rest.start - lineStart(view, i);
      const parsed = parseMappingAt(view, i, rest.start, childIndent, limit);
      item = parsed.value;
      i = parsed.next;
    } else {
      item = parseInline(text, rest.start, rest.stop, i).value;
      i += 1;
    }

    items.push(item);
    endLine = Math.max(endLine, valueEndLine(item, itemLine));
    spanEnd = Math.max(spanEnd, lineEnd(view, endLine));
  }

  const offset = lineStart(view, start) + indent;
  return {
    value: {
      kind: 'sequence',
      startLine: start,
      endLine,
      offset,
      length: Math.max(0, spanEnd - offset),
      items,
      flow: false,
    },
    next: i,
  };
}

/** `|` / `|-` / `>` / `>+` などに続く複数行スカラ。 */
function parseBlockScalar(
  view: LineView,
  keyLine: number,
  keyIndent: number,
  limit: number,
): Parsed<UnityScalar> {
  let last = keyLine;
  let i = keyLine + 1;
  while (i <= limit) {
    const ind = indentOf(view, i);
    if (ind < 0) {
      // 空行はブロックの一部かもしれないので、後ろに中身が続くかを見てから決める
      const ahead = nextContentLine(view, i + 1, limit);
      if (ahead !== 0 && indentOf(view, ahead) > keyIndent) {
        i += 1;
        continue;
      }
      break;
    }
    if (ind <= keyIndent) break;
    last = i;
    i += 1;
  }

  if (last === keyLine) {
    const end = lineEnd(view, keyLine);
    return { value: emptyScalar(keyLine, end), next: keyLine + 1 };
  }
  const offset = lineStart(view, keyLine + 1);
  const stop = lineEnd(view, last);
  return {
    value: {
      kind: 'scalar',
      startLine: keyLine,
      endLine: last,
      offset,
      length: Math.max(0, stop - offset),
      style: 'block',
    },
    next: last + 1,
  };
}

/* ------------------------------------------------------------------ 1 行の中 */

/**
 * 1 行に収まっている値。
 *
 * **フロー（`{...}` / `[...]`）はここで分解しない。** スカラとして範囲だけ持ち、
 * 中身が要るときに `expandFlow`（`parse/flow.ts`）で開く。
 * 素直に分解すると `{x: 0, y: 0, z: 0}` の 1 行が 11 オブジェクトになり、
 * 50MB のシーンで実測ヒープが元の 14 倍（708MB）になった（決定 32 / F-1）。
 */
function parseInline(text: string, from: number, to: number, lineNo: number): Parsed<UnityValue> {
  const c = text[from];
  if (c === '{' || c === '[') {
    return {
      value: {
        kind: 'scalar',
        startLine: lineNo,
        endLine: lineNo,
        offset: from,
        length: Math.max(0, to - from),
        style: 'flow',
      },
      next: to,
    };
  }
  return { value: makeScalar(text, from, to, lineNo), next: to };
}

/* ------------------------------------------------------------------ 小物 */

function makeScalar(text: string, from: number, to: number, lineNo: number): UnityScalar {
  let style: ScalarStyle = 'plain';
  if (from >= to) style = 'empty';
  else if (text[from] === "'") style = 'single';
  else if (text[from] === '"') style = 'double';
  return {
    kind: 'scalar',
    startLine: lineNo,
    endLine: lineNo,
    offset: from,
    length: Math.max(0, to - from),
    style,
  };
}

function emptyScalar(lineNo: number, offset: number): UnityScalar {
  return {
    kind: 'scalar',
    startLine: lineNo,
    endLine: lineNo,
    offset,
    length: 0,
    style: 'empty',
  };
}

function emptyMapping(lineNo: number, offset: number): UnityMapping {
  return {
    kind: 'mapping',
    startLine: lineNo,
    endLine: lineNo,
    offset,
    length: 0,
    entries: [],
    flow: false,
  };
}

function valueEndLine(value: UnityValue, fallback: number): number {
  return Math.max(value.endLine, fallback);
}

function startsWithDash(view: LineView, lineNo: number, indent: number): boolean {
  const pos = lineStart(view, lineNo) + indent;
  const end = lineEnd(view, lineNo);
  if (pos >= end || view.text.charCodeAt(pos) !== DASH) return false;
  // `- ` か、ハイフン単独の行。`-1` のような値と見分ける
  if (pos + 1 >= end) return true;
  const next = view.text.charCodeAt(pos + 1);
  return next === SPACE || next === TAB;
}

function isBlockScalarIndicator(text: string, from: number, to: number): boolean {
  const c = text[from];
  if (c !== '|' && c !== '>') return false;
  // `|` `|-` `|+` `>2` など、指示子の後ろに中身が無いこと
  for (let i = from + 1; i < to; i += 1) {
    const ch = text[i] ?? '';
    if (ch !== '-' && ch !== '+' && !(ch >= '0' && ch <= '9')) return false;
  }
  return true;
}

/** `from` 以降で最初の「中身のある行」。無ければ 0。 */
function nextContentLine(view: LineView, from: number, limit: number): number {
  for (let i = from; i <= limit && i <= view.lineCount; i += 1) {
    if (indentOf(view, i) >= 0) return i;
  }
  return 0;
}
