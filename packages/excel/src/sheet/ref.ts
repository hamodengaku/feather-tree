/*
 * セル番地（A1 形式）と行・列番号の変換。行・列は**0 始まり**で持つ。
 *
 * Excel の上限は 1,048,576 行 × 16,384 列（XFD）。
 */

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

/** 0 始まりの列番号 → 列文字（0 → A、25 → Z、26 → AA）。 */
export function columnName(col: number): string {
  let n = col + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** 0 始まりの行・列 → `B12`。 */
export function cellAddress(row: number, col: number): string {
  return columnName(col) + String(row + 1);
}

/** 解析したセル番地。読めなければ null。 */
export interface CellRef {
  readonly row: number;
  readonly col: number;
}

/**
 * `B12` / `$B$12` を読む（バイト範囲）。`r` 属性は `$` を含まないが、`mergeCell` の `ref` などと共用する。
 * 行が無い（`B`）・列が無い（`12`）ものは -1 を入れて返す（行・列だけの範囲の片端）。
 */
export function parseCellRefBytes(b: Uint8Array, start: number, end: number): CellRef | null {
  let at = start;
  if (b[at] === 0x24) at += 1;
  let col = 0;
  let letters = 0;
  while (at < end) {
    let c = b[at] ?? 0;
    if (c >= 0x61 && c <= 0x7a) c -= 0x20;
    if (c < 0x41 || c > 0x5a) break;
    col = col * 26 + (c - 0x40);
    letters += 1;
    if (letters > 3) return null;
    at += 1;
  }
  if (b[at] === 0x24) at += 1;
  let row = 0;
  let digits = 0;
  while (at < end) {
    const c = b[at] ?? 0;
    if (c < 0x30 || c > 0x39) break;
    row = row * 10 + (c - 0x30);
    digits += 1;
    if (digits > 7) return null;
    at += 1;
  }
  if (at !== end || (letters === 0 && digits === 0)) return null;
  if (letters > 0 && (col < 1 || col > MAX_COLS)) return null;
  if (digits > 0 && (row < 1 || row > MAX_ROWS)) return null;
  return { row: digits > 0 ? row - 1 : -1, col: letters > 0 ? col - 1 : -1 };
}

export function parseCellRef(text: string): CellRef | null {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c > 0x7f) return null;
    bytes[i] = c;
  }
  return parseCellRefBytes(bytes, 0, bytes.length);
}

/** `A1:C3` を 0 始まりの矩形に。1 点（`A1`）なら同じ点を 2 回。 */
export interface CellRange {
  readonly r1: number;
  readonly c1: number;
  readonly r2: number;
  readonly c2: number;
}

export function parseRange(text: string): CellRange | null {
  const colon = text.indexOf(':');
  const a = parseCellRef(colon < 0 ? text : text.slice(0, colon));
  const b = colon < 0 ? a : parseCellRef(text.slice(colon + 1));
  if (a === null || b === null || a.row < 0 || a.col < 0 || b.row < 0 || b.col < 0) return null;
  return {
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.col, b.col),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.col, b.col),
  };
}
