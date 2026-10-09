/*
 * CSV のコンフリクト（決定 34）。**バイト列のまま扱う純関数だけ。**
 *
 *   - `splitCsvConflict` … 作業ツリーのマーカー（`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`）を解いて、
 *     自分側・相手側の 2 つの CSV を作る。マーカーの外は git の 3-way マージの結果なので両側で同じになり、
 *     比べたときに違いとして出るのは**本当に衝突した所だけ**になる
 *   - `csvRecordSpans` … レコードと欄の**元のバイト範囲**（引用符込み）を取る
 *   - `composeCsv` … 行ごとの採り方から、採用した結果のバイト列を組む
 *
 * **文字列に戻さない。** CSV は UTF-8 のほかに Shift_JIS（日本語版 Excel の既定）で書かれていることがあり、
 * 標準の TextEncoder は Shift_JIS を書けない。区切り（`,` `"` CR LF）とマーカーの記号はどれも ASCII で、
 * UTF-8 の多バイト文字にも Shift_JIS の 2 バイト目（0x40 以上）にも現れないので、バイトのまま切り貼りすれば
 * 文字を壊さない。UTF-16 は記号が 2 バイトになるので扱わない（`unsupported`）。
 *
 * 記号の読み方は `csvRecords`（csv.ts）・`parseConflictMarkers`（git 層の conflict.ts）と同じにしてある。
 * ここがずれると、画面に出したセルと書き戻す欄が食い違う。
 */

import type { CsvEncoding } from './csv.js';

const LF = 0x0a;
const CR = 0x0d;
const COMMA = 0x2c;
const QUOTE = 0x22;
const SPACE = 0x20;

export type CsvConflictSplit =
  | {
      readonly kind: 'split';
      readonly ours: Uint8Array;
      readonly theirs: Uint8Array;
      /** 衝突のブロックの数。 */
      readonly blocks: number;
    }
  /** マーカーが 1 つも無い（解消済み・未着手で段の中身のまま）。 */
  | { readonly kind: 'none' }
  /** 閉じていない・入れ子。どちらの側の行か決められない。 */
  | { readonly kind: 'malformed' }
  /** UTF-16（記号がバイト単位で読めない）。 */
  | { readonly kind: 'unsupported' };

function isUtf16(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
}

/** 行の範囲（LF を含む）と、CR・LF を除いた本文の終わり。 */
interface LineSpan {
  readonly start: number;
  /** 本文の終わり（CR LF / LF を含まない）。 */
  readonly bodyEnd: number;
  /** 次の行の頭（LF の直後。最後の行に LF が無ければ末尾）。 */
  readonly end: number;
}

function splitLineSpans(bytes: Uint8Array): LineSpan[] {
  const out: LineSpan[] = [];
  let start = 0;
  while (start < bytes.length) {
    const nl = bytes.indexOf(LF, start);
    if (nl < 0) {
      out.push({ start, bodyEnd: bytes.length, end: bytes.length });
      break;
    }
    const bodyEnd = nl > start && bytes[nl - 1] === CR ? nl - 1 : nl;
    out.push({ start, bodyEnd, end: nl + 1 });
    start = nl + 1;
  }
  return out;
}

/** 7 文字の記号のあと、行末か空白（ラベル）が続くか。git 層の `( .*)?$` と同じ（8 文字目が同じ記号なら違う）。 */
function isMarker(bytes: Uint8Array, line: LineSpan, symbol: number, labelled: boolean): boolean {
  const length = line.bodyEnd - line.start;
  if (length < 7) return false;
  for (let k = 0; k < 7; k += 1) if (bytes[line.start + k] !== symbol) return false;
  if (length === 7) return true;
  return labelled && bytes[line.start + 7] === SPACE;
}

/**
 * 作業ツリーのマーカーを解いて、自分側・相手側の CSV を作る。
 *
 * diff3 形式（`|||||||` の共通祖先の節）はどちらの側にも入れない。ファイルが `>>>>>>>` の行で
 * 改行なしに終わっていれば、組んだ結果も改行なしで終える（`resolveConflictBlock` と同じ。
 * 採用で改行が 1 つ増えると、git の diff に「\ No newline at end of file」の出入りとして出る）。
 */
export function splitCsvConflict(bytes: Uint8Array): CsvConflictSplit {
  if (isUtf16(bytes)) return { kind: 'unsupported' };
  const lines = splitLineSpans(bytes);
  const ours: LineSpan[] = [];
  const theirs: LineSpan[] = [];
  let blocks = 0;
  let endsInsideMarker = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as LineSpan;
    if (!isMarker(bytes, line, 0x3c /* < */, true)) {
      ours.push(line);
      theirs.push(line);
      i += 1;
      continue;
    }
    let base = -1;
    let separator = -1;
    let end = -1;
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const body = lines[j] as LineSpan;
      if (isMarker(bytes, body, 0x3c, true)) return { kind: 'malformed' };
      if (separator < 0 && base < 0 && isMarker(bytes, body, 0x7c /* | */, true)) {
        base = j;
        continue;
      }
      if (separator < 0) {
        if (isMarker(bytes, body, 0x3d /* = */, false)) separator = j;
        continue;
      }
      if (isMarker(bytes, body, 0x3e /* > */, true)) {
        end = j;
        break;
      }
    }
    if (separator < 0 || end < 0) return { kind: 'malformed' };
    for (let k = i + 1; k < (base >= 0 ? base : separator); k += 1) ours.push(lines[k] as LineSpan);
    for (let k = separator + 1; k < end; k += 1) theirs.push(lines[k] as LineSpan);
    blocks += 1;
    endsInsideMarker = end === lines.length - 1 && (lines[end] as LineSpan).end === (lines[end] as LineSpan).bodyEnd;
    i = end + 1;
  }
  if (blocks === 0) return { kind: 'none' };
  return {
    kind: 'split',
    ours: joinSpans(bytes, ours, endsInsideMarker),
    theirs: joinSpans(bytes, theirs, endsInsideMarker),
    blocks,
  };
}

function joinSpans(bytes: Uint8Array, spans: readonly LineSpan[], stripLastNewline: boolean): Uint8Array {
  let total = 0;
  for (const s of spans) total += s.end - s.start;
  const out = new Uint8Array(total);
  let at = 0;
  for (const s of spans) {
    out.set(bytes.subarray(s.start, s.end), at);
    at += s.end - s.start;
  }
  if (!stripLastNewline) return out;
  const last = spans[spans.length - 1];
  if (last === undefined) return out;
  // 最後の行の改行（CR LF / LF）だけを落とす
  return out.subarray(0, total - (last.end - last.bodyEnd));
}

/** 1 レコードの元のバイト範囲。 */
export interface CsvRecordSpan {
  /** 欄ごとの [start, end)（引用符込みの生のバイト）。 */
  readonly fields: readonly (readonly [number, number])[];
  /** 改行（CR LF / LF / CR）。最後のレコードで改行が無ければ空の範囲。 */
  readonly terminator: readonly [number, number];
}

export interface CsvSpans {
  /** UTF-8 の BOM の長さ（0 か 3）。レコードの範囲はこの後ろから数える。 */
  readonly bom: number;
  readonly records: readonly CsvRecordSpan[];
}

/**
 * レコードと欄のバイト範囲を取る。区切りの読み方は `csvRecords` と同じ
 * （引用符の中の改行・カンマ・`""`、閉じていない引用符は残り全部、引用符の後ろの文字も値に足す）。
 */
export function csvRecordSpans(bytes: Uint8Array): CsvSpans {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const n = bytes.length;
  const records: CsvRecordSpan[] = [];
  let i = bom;
  while (i < n) {
    const fields: [number, number][] = [];
    let terminator: [number, number] = [n, n];
    for (;;) {
      const start = i;
      if (i < n && bytes[i] === QUOTE) {
        i += 1;
        for (;;) {
          const q = bytes.indexOf(QUOTE, i);
          if (q < 0) {
            i = n;
            break;
          }
          if (bytes[q + 1] === QUOTE) {
            i = q + 2;
            continue;
          }
          i = q + 1;
          break;
        }
      }
      while (i < n) {
        const c = bytes[i];
        if (c === COMMA || c === LF || c === CR) break;
        i += 1;
      }
      fields.push([start, i]);
      if (i >= n) break;
      const c = bytes[i];
      if (c === COMMA) {
        i += 1;
        continue;
      }
      const tStart = i;
      i += 1;
      if (c === CR && bytes[i] === LF) i += 1;
      terminator = [tStart, i];
      break;
    }
    records.push({ fields, terminator });
  }
  return { bom, records };
}

/** 採用の結果の 1 行。並び順に出す。出さない行は入れない。 */
export type CsvRowPlan =
  /** 自分側のレコードを丸ごと（元のバイトのまま）。 */
  | { readonly kind: 'ours'; readonly row: number }
  | { readonly kind: 'theirs'; readonly row: number }
  /**
   * 欄ごとに継ぎ合わせる。theirsCols に無い列は自分側の欄。edits の列は、利用者が打った値
   * （encodeCsvField で引用符と文字コードを済ませたバイト列）を書く（docs/07 7.1）。
   */
  | {
      readonly kind: 'mixed';
      readonly oursRow: number;
      readonly theirsRow: number;
      readonly theirsCols: ReadonlySet<number>;
      readonly edits?: ReadonlyMap<number, Uint8Array>;
    };

/**
 * 行ごとの採り方から、採用した結果のバイト列を組む。
 *
 * 改行は各レコードが持っていたものを使う（自分側の改行コードを保つ）。ファイル末尾の改行の有無は
 * 自分側に合わせる。末尾以外で改行を持たないレコード（元のファイルの最後の行が途中に来た）には、
 * 自分側で最初に見つかった改行を補う。
 */
export function composeCsv(ours: Uint8Array, theirs: Uint8Array, plans: readonly CsvRowPlan[]): Uint8Array {
  const o = csvRecordSpans(ours);
  const t = csvRecordSpans(theirs);
  const eol = firstTerminator(ours, o) ?? Uint8Array.of(LF);
  const lastO = o.records[o.records.length - 1];
  const endsWithNewline = lastO === undefined ? true : lastO.terminator[1] > lastO.terminator[0];

  const parts: Uint8Array[] = [];
  if (o.bom > 0) parts.push(ours.subarray(0, o.bom));

  plans.forEach((plan, index) => {
    const isLast = index === plans.length - 1;
    let terminator: Uint8Array;
    if (plan.kind === 'mixed') {
      const ro = o.records[plan.oursRow];
      const rt = t.records[plan.theirsRow];
      let count = Math.max(ro?.fields.length ?? 0, rt?.fields.length ?? 0);
      for (const c of plan.edits?.keys() ?? []) count = Math.max(count, c + 1);
      for (let c = 0; c < count; c += 1) {
        if (c > 0) parts.push(Uint8Array.of(COMMA));
        const edited = plan.edits?.get(c);
        if (edited !== undefined) {
          parts.push(edited);
          continue;
        }
        // 自分側の行が無い（oursRow = -1。相手側の行に打った値を当てる）なら、欄はすべて相手側から
        const fromTheirs = plan.theirsCols.has(c) || ro === undefined;
        const span = (fromTheirs ? rt : ro)?.fields[c];
        if (span !== undefined) parts.push((fromTheirs ? theirs : ours).subarray(span[0], span[1]));
      }
      terminator =
        ro !== undefined
          ? ours.subarray(ro.terminator[0], ro.terminator[1])
          : rt !== undefined
            ? theirs.subarray(rt.terminator[0], rt.terminator[1])
            : new Uint8Array(0);
    } else {
      const source = plan.kind === 'ours' ? ours : theirs;
      const record = (plan.kind === 'ours' ? o : t).records[plan.row];
      if (record === undefined) return;
      const first = record.fields[0];
      const last = record.fields[record.fields.length - 1];
      if (first !== undefined && last !== undefined) parts.push(source.subarray(first[0], last[1]));
      terminator = source.subarray(record.terminator[0], record.terminator[1]);
    }
    if (isLast) {
      if (endsWithNewline) parts.push(terminator.length > 0 ? terminator : eol);
    } else {
      parts.push(terminator.length > 0 ? terminator : eol);
    }
  });

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function firstTerminator(bytes: Uint8Array, spans: CsvSpans): Uint8Array | null {
  for (const r of spans.records) {
    if (r.terminator[1] > r.terminator[0]) return bytes.subarray(r.terminator[0], r.terminator[1]);
  }
  return null;
}

/** 引用符で囲む必要がある欄か（カンマ・引用符・改行・前後の空白）。 */
function needsQuote(text: string): boolean {
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c === 0x22 || c === 0x2c || c === 0x0a || c === 0x0d) return true;
  }
  const first = text.charCodeAt(0);
  const last = text.charCodeAt(text.length - 1);
  return text.length > 0 && (first === 0x20 || first === 0x09 || last === 0x20 || last === 0x09);
}

let sjisTable: Map<string, Uint8Array> | null = null;

/**
 * Shift_JIS の逆引き表。標準の TextEncoder は Shift_JIS を書けないので、TextDecoder で 2 バイトの並びを
 * 一通り読んで作る（初めて要るときに 1 回だけ。1 万件ほど）。
 */
function shiftJisTable(): Map<string, Uint8Array> {
  if (sjisTable !== null) return sjisTable;
  const table = new Map<string, Uint8Array>();
  const decoder = new TextDecoder('shift_jis', { fatal: true });
  const tryAdd = (bytes: Uint8Array): void => {
    let ch: string;
    try {
      ch = decoder.decode(bytes);
    } catch {
      return;
    }
    // 置換文字（U+FFFD）は読めなかった印なので表に入れない
    if (ch.length > 0 && ch.charCodeAt(0) !== 0xfffd && !table.has(ch)) table.set(ch, bytes);
  };
  for (let b = 0; b < 0x80; b += 1) tryAdd(Uint8Array.of(b));
  for (let b = 0xa1; b <= 0xdf; b += 1) tryAdd(Uint8Array.of(b));
  for (let lead = 0x81; lead <= 0xfc; lead += 1) {
    if (lead > 0x9f && lead < 0xe0) continue;
    for (let trail = 0x40; trail <= 0xfc; trail += 1) {
      if (trail === 0x7f) continue;
      tryAdd(Uint8Array.of(lead, trail));
    }
  }
  sjisTable = table;
  return table;
}

/**
 * 利用者が打った値を CSV の 1 欄にする（docs/07 7.1）。必要なら引用符で囲み、ファイルの文字コードで書く。
 * その文字コードで書けない文字がある・UTF-16 なら null。
 */
export function encodeCsvField(text: string, encoding: CsvEncoding): Uint8Array | null {
  const field = needsQuote(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  if (encoding === 'utf-8') return new TextEncoder().encode(field);
  if (encoding !== 'shift_jis') return null;
  const table = shiftJisTable();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const ch of field) {
    const bytes = table.get(ch);
    if (bytes === undefined) return null;
    parts.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
