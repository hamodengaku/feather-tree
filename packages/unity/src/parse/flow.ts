/*
 * フロー（`{x: 0, y: 0, z: 0}` / `[a, b]`）を**必要になったときだけ**分解する（決定 32）。
 *
 * パース時に分解しないのは実測にもとづく。50MB のシーンを素直に分解すると
 * 1 行あたり 11 オブジェクトになり、ヒープが元の 14 倍（708MB）に膨れた。
 * フローの中身が要るのは
 *   - 利用者が選んだ 1 ノードの表を作るとき（`m_LocalPosition.x` のような行）
 *   - ヒエラルキーを組むときの `{fileID: N}`（こちらは `scanFileId` で直接読む）
 * だけなので、前者にだけこのモジュールを使う。
 */

import type { UnityEntry, UnityMapping, UnitySequence, UnityValue } from '../model/types.js';
import { skipQuoted, trimRange } from './lexer.js';

const SPACE = 32;
const TAB = 9;

interface Parsed<T> {
  readonly value: T;
  readonly next: number;
}

/**
 * フローのスカラを、マッピング / シーケンスに開く。
 * フローでない値、または中身が無いものはそのまま返す。
 */
export function expandFlow(text: string, value: UnityValue): UnityValue {
  if (value.kind !== 'scalar' || value.style !== 'flow') return value;
  const from = value.offset;
  const to = value.offset + value.length;
  const head = text[from];
  if (head === '{') return parseFlowMapping(text, from, to, value.startLine).value;
  if (head === '[') return parseFlowSequence(text, from, to, value.startLine).value;
  return value;
}

/**
 * `{fileID: 123}` の fileID を、オブジェクトを一切作らずに読む。
 *
 * ヒエラルキーの組み立て（`m_GameObject` / `m_Father` / `m_Children`）は
 * ファイル内の全ノードに対して走るので、ここで `expandFlow` を呼ぶと
 * 遅延にした意味が無くなる。キー名を直接探して値だけ切り出す。
 */
export function scanFlowValue(text: string, from: number, to: number, key: string): string {
  let i = from;
  let depth = 0;
  while (i < to) {
    const c = text[i];
    if (c === "'" || c === '"') {
      i = skipQuoted(text, i, to);
      continue;
    }
    if (c === '{' || c === '[') {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === '}' || c === ']') {
      depth -= 1;
      i += 1;
      continue;
    }
    // 入れ子の中は見ない（`{a: {fileID: 1}, fileID: 2}` で内側を拾わないため）
    if (depth === 1 && text.startsWith(key, i) && isKeyBoundary(text, i, i + key.length, to)) {
      const colon = i + key.length;
      if (text[colon] === ':') {
        const start = skipSpaces(text, colon + 1, to);
        let stop = start;
        let inner = 0;
        while (stop < to) {
          const ch = text[stop];
          if (ch === "'" || ch === '"') {
            stop = skipQuoted(text, stop, to);
            continue;
          }
          if (ch === '{' || ch === '[') inner += 1;
          else if (ch === '}' || ch === ']') {
            if (inner === 0) break;
            inner -= 1;
          } else if (ch === ',' && inner === 0) break;
          stop += 1;
        }
        const trimmed = trimRange(text, start, stop);
        return text.slice(trimmed.start, trimmed.stop);
      }
    }
    i += 1;
  }
  return '';
}

/** そこが本当にキーの始まりか（`m_fileID` の中の `fileID` を拾わない）。 */
function isKeyBoundary(text: string, start: number, end: number, to: number): boolean {
  if (end >= to) return false;
  if (start === 0) return true;
  const before = text[start - 1];
  return before === '{' || before === ',' || before === ' ' || before === '[';
}

/* ------------------------------------------------------------------ 分解 */

function parseFlowMapping(
  text: string,
  from: number,
  to: number,
  lineNo: number,
): Parsed<UnityMapping> {
  const entries: UnityEntry[] = [];
  let i = from + 1;

  while (i < to) {
    i = skipSpaces(text, i, to);
    if (i >= to) break;
    if (text[i] === '}') {
      i += 1;
      break;
    }
    if (text[i] === ',') {
      i += 1;
      continue;
    }

    const keyStart = i;
    const keyEnd = findFlowKeyEnd(text, i, to);
    if (keyEnd < 0) break;
    const key = text.slice(keyStart, keyEnd).trim();

    i = skipSpaces(text, keyEnd + 1, to);
    const parsed = parseFlowItem(text, i, to, lineNo);
    entries.push({ key, keyLine: lineNo, value: parsed.value });
    i = skipSpaces(text, parsed.next, to);
    if (i < to && text[i] === ',') i += 1;
    else if (i < to && text[i] === '}') {
      i += 1;
      break;
    }
  }

  return {
    value: {
      kind: 'mapping',
      startLine: lineNo,
      endLine: lineNo,
      offset: from,
      length: i - from,
      entries,
      flow: true,
    },
    next: i,
  };
}

function parseFlowSequence(
  text: string,
  from: number,
  to: number,
  lineNo: number,
): Parsed<UnitySequence> {
  const items: UnityValue[] = [];
  let i = from + 1;

  while (i < to) {
    i = skipSpaces(text, i, to);
    if (i >= to) break;
    if (text[i] === ']') {
      i += 1;
      break;
    }
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    const parsed = parseFlowItem(text, i, to, lineNo);
    items.push(parsed.value);
    i = skipSpaces(text, parsed.next, to);
    if (i < to && text[i] === ',') i += 1;
    else if (i < to && text[i] === ']') {
      i += 1;
      break;
    }
  }

  return {
    value: {
      kind: 'sequence',
      startLine: lineNo,
      endLine: lineNo,
      offset: from,
      length: i - from,
      items,
      flow: true,
    },
    next: i,
  };
}

/** フローの中の 1 要素。入れ子のフローもその場で開く（ここまで来たら量は知れている）。 */
function parseFlowItem(text: string, from: number, to: number, lineNo: number): Parsed<UnityValue> {
  const c = text[from];
  if (c === '{') return parseFlowMapping(text, from, to, lineNo);
  if (c === '[') return parseFlowSequence(text, from, to, lineNo);

  let i = from;
  let depth = 0;
  while (i < to) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(text, i, to);
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ',' && depth === 0) break;
    i += 1;
  }
  const trimmed = trimRange(text, from, i);
  let style: 'plain' | 'single' | 'double' | 'empty' = 'plain';
  if (trimmed.start >= trimmed.stop) style = 'empty';
  else if (text[trimmed.start] === "'") style = 'single';
  else if (text[trimmed.start] === '"') style = 'double';
  return {
    value: {
      kind: 'scalar',
      startLine: lineNo,
      endLine: lineNo,
      offset: trimmed.start,
      length: trimmed.stop - trimmed.start,
      style,
    },
    next: i,
  };
}

/**
 * フローマッピングのキーを終わらせるコロンの位置。
 * `{fileID: 0}` の `fileID` のように素のキーしか来ない前提だが、
 * 引用符と入れ子は一応飛ばす。
 */
function findFlowKeyEnd(text: string, from: number, to: number): number {
  let i = from;
  let depth = 0;
  while (i < to) {
    const c = text[i];
    if (c === "'" || c === '"') {
      i = skipQuoted(text, i, to);
      continue;
    }
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (c === ':' && depth === 0) return i;
    else if (c === ',' && depth === 0) return -1;
    i += 1;
  }
  return -1;
}

function skipSpaces(text: string, from: number, to: number): number {
  let i = from;
  while (i < to) {
    const c = text.charCodeAt(i);
    if (c !== SPACE && c !== TAB) break;
    i += 1;
  }
  return i;
}
