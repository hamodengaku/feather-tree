/*
 * CSV を開く（2026-10-02、利用者の指示で Excel 差分モードの対象に CSV を加えた）。
 *
 * ブックと同じモデル（シート 1 枚）に載せるので、比較・幾何・行単位比較・描画は手を入れずに使える。
 *
 *   - **値はすべて文字列（CELL_INLINE）で持つ。** 数値に直すと `0001` が `1` に、`1.0` と `1` が
 *     同じ値に見えてしまい、CSV のテキストとしての差分を隠す
 *   - 文字コード: BOM（UTF-8 / UTF-16）があればそれに従う。無ければ UTF-8 として厳密に読み、
 *     読めなければ Shift_JIS（日本語版 Excel が既定で書き出す形）で読む
 *   - 書式は持たない（styles = null。すべて既定の見た目）
 *   - 区切りはカンマだけ。引用符（RFC 4180）の中の改行・カンマ・`""` を扱う
 *
 * このパッケージは Node を知らない（`.dependency-cruiser.cjs` の no-node-in-excel）ので、
 * 文字コードの変換は標準の `TextDecoder` だけで行う。
 */

import { DEFAULT_LIMITS, type ExcelLimits } from '../limits.js';
import {
  CELL_INLINE,
  FORMULA_NONE,
  type CellData,
  type OpenFailure,
  type OpenResult,
  type RowData,
  type SheetData,
  type SheetProblem,
  type Workbook,
} from '../model/types.js';
import { DEFAULT_COL_WIDTH_PX, DEFAULT_ROW_HEIGHT_PT } from '../sheet/worksheet.js';
import { sniffExcel } from '../sniff.js';

/** シート名。新旧の両側で同じ名前にしないと、シートの対応付け（名前で取る）が外れる。 */
export const CSV_SHEET_NAME = 'CSV';

/** この行数ごとに 1 回 yield する（呼び出し側がイベントループへ譲り、中止を確かめる）。 */
const ROWS_PER_STEP = 5000;

/** バイナリかどうかを見る先頭の長さ。git の判定（NUL の有無）と同じ考え方。 */
const BINARY_PROBE_BYTES = 8000;

export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'shift_jis';

/** バイト列を文字列にする。読めない（バイナリ）なら null。 */
export function decodeCsv(bytes: Uint8Array): { readonly text: string; readonly encoding: CsvEncoding } | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }
  // UTF-16 は NUL を含むので、BOM を見た後で判定する
  const probe = bytes.subarray(0, BINARY_PROBE_BYTES);
  if (probe.includes(0)) return null;

  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' };
  } catch {
    // UTF-8 として不正 → 日本語環境の Excel が書き出す Shift_JIS とみなす
  }
  try {
    return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'shift_jis' };
  } catch {
    // 実行環境が Shift_JIS を知らない（ICU を削った Node 等）。置換文字入りの UTF-8 で見せる
    return { text: new TextDecoder('utf-8').decode(body), encoding: 'utf-8' };
  }
}

/**
 * CSV を 1 レコードずつ取り出す（RFC 4180）。
 *
 * 改行は CRLF・LF・CR のどれでもよい。引用符の中の改行は値の一部。
 * 末尾の改行の後ろ（空の最終行）はレコードにしない。
 */
export function* csvRecords(text: string): Generator<string[]> {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const fields: string[] = [];
    let field = '';
    let ended = false;
    while (!ended) {
      if (i < n && text.charCodeAt(i) === 0x22 /* " */) {
        // 引用符つきの値
        i += 1;
        for (;;) {
          const q = text.indexOf('"', i);
          if (q < 0) {
            // 閉じていない引用符: 残りをすべて値にする（壊れた CSV でも落とさない）
            field += text.slice(i);
            i = n;
            break;
          }
          field += text.slice(i, q);
          if (text.charCodeAt(q + 1) === 0x22) {
            field += '"';
            i = q + 2;
            continue;
          }
          i = q + 1;
          break;
        }
      }
      // 引用符の外（引用符の後ろに続く文字も、Excel と同じく値に足す）
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 0x2c /* , */ || c === 0x0a || c === 0x0d) break;
        field += text[i];
        i += 1;
      }
      fields.push(field);
      field = '';
      if (i >= n) {
        ended = true;
      } else {
        const c = text.charCodeAt(i);
        i += 1;
        if (c === 0x2c) continue;
        if (c === 0x0d && text.charCodeAt(i) === 0x0a) i += 1;
        ended = true;
      }
    }
    yield fields;
  }
}

/** CSV を開く。ROWS_PER_STEP 行ごとに 1 回 yield し、最後に結果を返す。 */
export function* openCsvSteps(
  bytes: Uint8Array,
  limits: ExcelLimits = DEFAULT_LIMITS,
): Generator<void, OpenResult> {
  const failed = (reason: OpenFailure): OpenResult => ({ ok: false, reason });

  if (bytes.length > limits.maxFileBytes) return failed('too-large');
  switch (sniffExcel(bytes)) {
    case 'empty':
      return failed('empty');
    case 'lfs-pointer':
      return failed('lfs-pointer');
    case 'zip':
    case 'cfb':
      // 拡張子だけ .csv のブック等
      return failed('not-spreadsheet');
    default:
      break;
  }

  const decoded = decodeCsv(bytes);
  if (decoded === null) return failed('not-spreadsheet');

  const rows: (RowData | undefined)[] = [];
  let maxCol = -1;
  let cellCount = 0;
  let problem: SheetProblem | null = null;
  let columnsTruncated = false;
  const cellLimit = Math.min(limits.maxCellsPerSheet, limits.maxCellsPerBook);

  let r = 0;
  for (const fields of csvRecords(decoded.text)) {
    if (r >= limits.maxRowsPerSheet) {
      problem = 'too-large';
      break;
    }
    const cells: CellData[] = [];
    for (let c = 0; c < fields.length; c += 1) {
      if (c >= limits.maxColumns) {
        columnsTruncated = true;
        break;
      }
      const value = fields[c] ?? '';
      // 空の値はセルを作らない（ブックの空セルと同じ扱い。比較でも「値なし」になる）
      if (value === '') continue;
      cells.push({ col: c, kind: CELL_INLINE, num: 0, text: value, formula: null, formulaKind: FORMULA_NONE, style: 0 });
      if (c > maxCol) maxCol = c;
    }
    if (cellCount + cells.length > cellLimit) {
      problem = 'too-large';
      break;
    }
    cellCount += cells.length;
    if (cells.length > 0) {
      rows[r] = { row: r, heightPt: Number.NaN, hidden: false, style: -1, cells };
    }
    r += 1;
    if (r % ROWS_PER_STEP === 0) yield;
  }

  // 末尾の空行（値の無いレコード）は行数に数えない
  let maxRow = rows.length - 1;
  while (maxRow >= 0 && rows[maxRow] === undefined) maxRow -= 1;
  rows.length = maxRow + 1;

  const data: SheetData = {
    rows,
    maxRow,
    maxCol,
    defaultRowHeightPt: DEFAULT_ROW_HEIGHT_PT,
    defaultColWidthPx: DEFAULT_COL_WIDTH_PX,
    cols: [],
    merges: new Int32Array(0),
    frozen: null,
    cellCount,
    problem,
    columnsTruncated,
  };
  const workbook: Workbook = {
    sheets: [{ name: CSV_SHEET_NAME, sheetId: 1, state: 'visible', kind: 'worksheet', data, problem }],
    sst: [],
    date1904: false,
    vbaCrc: null,
    styles: null,
  };
  return { ok: true, workbook };
}

/** 同期でまとめて開く（テスト・小さなファイル用）。 */
export function openCsv(bytes: Uint8Array, limits: ExcelLimits = DEFAULT_LIMITS): OpenResult {
  const steps = openCsvSteps(bytes, limits);
  for (;;) {
    const r = steps.next();
    if (r.done === true) return r.value;
  }
}
