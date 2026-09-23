/*
 * 値を「表に出す文字列」にする（決定 32）。
 *
 * パースの時点では (offset, length) しか持たない（F-1）ので、
 * 文字列を作るのは**表の行を組み立てるこの瞬間だけ**。
 * ヒエラルキーのノード数ぶんではなく、利用者が選んだ 1 ノードぶんしか呼ばれない。
 */

import type { UnityScalar, UnityValue } from '../model/types.js';
import { expandFlow, scanFlowValue } from './flow.js';
import { type LineView, lineEnd, lineStart } from './lexer.js';

const BACKSLASH = String.fromCharCode(92);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);

/** 値の生テキスト（元ファイルに書かれているとおり）。 */
export function rawText(file: LineView, value: UnityValue): string {
  return file.text.slice(value.offset, value.offset + value.length);
}

/**
 * スカラを表示用の文字列にする。引用符とブロック指示子を剥がす。
 *
 * ここで剥がすのは**見せるため**であって、パッチを作るときには使わない
 * （パッチは git の diff の行をそのまま使うので、復元の正確さを要求されない）。
 */
export function readScalar(file: LineView, scalar: UnityScalar): string {
  const raw = rawText(file, scalar);
  switch (scalar.style) {
    case 'empty':
      return '';
    case 'plain':
    case 'flow':
      return raw.trim();
    case 'single':
      return unquoteSingle(raw);
    case 'double':
      return unquoteDouble(raw);
    case 'block':
      return readBlock(file, scalar);
  }
}

/**
 * 値を 1 行の表示文字列にする。
 *
 * フロー（`{x: 0, y: 1, z: 0}`）は**元の書き方のまま**出す。整形し直すと
 * 「変更前 / 変更後」の見た目が元ファイルと食い違い、差分を目で追えなくなる。
 * 複数行に渡るものは改行を空白に畳む。
 */
export function displayValue(file: LineView, value: UnityValue): string {
  if (value.kind === 'scalar') return readScalar(file, value);
  const raw = rawText(file, value);
  if (value.startLine === value.endLine) return raw.trim();
  return collapseLines(raw);
}

function unquoteSingle(raw: string): string {
  const body = stripQuotes(raw, "'");
  return body.split("''").join("'");
}

function unquoteDouble(raw: string): string {
  const body = stripQuotes(raw, '"');
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c !== BACKSLASH) {
      out += c;
      continue;
    }
    const next = body[i + 1];
    i += 1;
    switch (next) {
      case 'n':
        out += LF;
        break;
      case 'r':
        out += CR;
        break;
      case 't':
        out += TAB;
        break;
      case undefined:
        out += BACKSLASH;
        break;
      default:
        // `\\` と `\"` はその文字そのもの。未知のエスケープも同じ扱いにして落とさない
        out += next;
        break;
    }
  }
  return out;
}

function stripQuotes(raw: string, quote: string): string {
  let body = raw;
  if (body.startsWith(quote)) body = body.slice(1);
  if (body.endsWith(quote)) body = body.slice(0, -1);
  return body;
}

/**
 * ブロックスカラ（`|` / `>`）の中身。
 * 各行から共通のインデントを取り除いて繋ぐ。
 */
function readBlock(file: LineView, scalar: UnityScalar): string {
  const lines: string[] = [];
  let common = Number.MAX_SAFE_INTEGER;
  for (let i = scalar.startLine + 1; i <= scalar.endLine; i += 1) {
    const text = file.text.slice(lineStart(file, i), lineEnd(file, i));
    lines.push(text);
    const trimmed = text.trimStart();
    if (trimmed.length > 0) common = Math.min(common, text.length - trimmed.length);
  }
  if (common === Number.MAX_SAFE_INTEGER) common = 0;
  return lines.map((l) => l.slice(common)).join(LF);
}

function collapseLines(raw: string): string {
  return raw
    .split(LF)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(' ');
}

/**
 * マッピングから 1 件引く。重複キーがあれば `occurrence` 番目（0 始まり）。
 *
 * フローのスカラ（まだ分解していない `{...}`）も引けるように、
 * 必要ならその場で開く。開いた結果は**保持しない**——保持すると
 * 遅延にした意味が無くなる（F-1）。
 */
export function entryOf(
  file: LineView,
  value: UnityValue,
  key: string,
  occurrence = 0,
): UnityValue | null {
  const target = value.kind === 'scalar' ? expandFlow(file.text, value) : value;
  if (target.kind !== 'mapping') return null;
  let seen = 0;
  for (const entry of target.entries) {
    if (entry.key !== key) continue;
    if (seen === occurrence) return entry.value;
    seen += 1;
  }
  return null;
}

/**
 * `{fileID: 123}` の fileID。無ければ空文字。
 *
 * **オブジェクトを作らずに読む。** ヒエラルキーの組み立て（`m_GameObject` /
 * `m_Father` / `m_Children`）はファイル内の全ノードに対して走るので、
 * ここで `expandFlow` を呼ぶと遅延にした意味が無くなる（F-1）。
 */
export function fileIdOf(file: LineView, value: UnityValue | null): string {
  return scanKey(file, value, 'fileID');
}

/** `{fileID: 1, guid: abc, type: 3}` の guid。無ければ空文字。 */
export function guidOf(file: LineView, value: UnityValue | null): string {
  return scanKey(file, value, 'guid');
}

function scanKey(file: LineView, value: UnityValue | null, key: string): string {
  if (value === null) return '';
  if (value.kind === 'scalar') {
    if (value.style !== 'flow') return '';
    return scanFlowValue(file.text, value.offset, value.offset + value.length, key);
  }
  if (value.kind !== 'mapping') return '';
  for (const entry of value.entries) {
    if (entry.key === key && entry.value.kind === 'scalar') return readScalar(file, entry.value);
  }
  return '';
}
