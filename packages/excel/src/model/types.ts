import type { StyleTable } from '../style/styles.js';

/*
 * ブックのモデル（決定 33）。行・列は**0 始まり**。
 *
 * セルは数が多い（100 万）ので、1 セル 1 オブジェクトでも中身を最小にする。共有文字列は
 * 文字列ではなく添字（`num`）で持ち、ブックの `sst` を引く——同じ文字列を何万回も複写しない。
 */

/** セルの値の種類。数値で持つ（文字列の比較を避ける）。 */
export const CELL_BLANK = 0; // 値の無いセル（書式だけ）
export const CELL_NUMBER = 1;
export const CELL_SHARED = 2; // 共有文字列。num が sst の添字
export const CELL_INLINE = 3; // インライン文字列。text に本文
export const CELL_BOOL = 4; // num が 0 / 1
export const CELL_ERROR = 5; // text が #N/A など
export const CELL_FORMULA_STR = 6; // 数式の結果の文字列（t="str"）。text に本文
export const CELL_DATE = 7; // ISO 8601 の日時（t="d"）。text に本文

export type CellKind = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** 数式の種類。 */
export const FORMULA_NONE = 0;
export const FORMULA_NORMAL = 1;
export const FORMULA_SHARED = 2;
export const FORMULA_ARRAY = 3;
export const FORMULA_DATA_TABLE = 4;

export type FormulaKind = 0 | 1 | 2 | 3 | 4;

export interface CellData {
  readonly col: number;
  readonly kind: CellKind;
  /** 数値・真偽・共有文字列の添字。 */
  readonly num: number;
  /** インライン文字列・数式の文字列結果・エラー・日時の本文。 */
  readonly text: string | null;
  /** 数式（先頭の `=` は付けない）。共有数式はこのセルの位置へずらした後のもの。 */
  readonly formula: string | null;
  readonly formulaKind: FormulaKind;
  /** セル書式の添字（`cellXfs`）。0 が既定。 */
  readonly style: number;
}

export interface RowData {
  readonly row: number;
  /** 行の高さ（pt）。指定が無ければ NaN（シートの既定を使う）。 */
  readonly heightPt: number;
  readonly hidden: boolean;
  /** 行全体の書式（cellXfs の添字）。セルの無い位置に効く。指定が無ければ -1。 */
  readonly style: number;
  /** 列の昇順。 */
  readonly cells: readonly CellData[];
}

export interface ColumnSpec {
  /** 0 始まり・両端を含む。 */
  readonly min: number;
  readonly max: number;
  /** 幅（px。ファイルの width を画素に直したもの）。指定が無ければ NaN。 */
  readonly widthPx: number;
  readonly hidden: boolean;
  /** 列全体の書式（cellXfs の添字）。行の書式もセルも無い位置に効く。指定が無ければ -1。 */
  readonly style: number;
}

export type SheetProblem = 'too-large' | 'broken' | 'missing-part' | 'unsupported';

export interface SheetData {
  /** 行番号で引ける疎な配列（長さは最終行 + 1）。 */
  readonly rows: readonly (RowData | undefined)[];
  /** 最終行・最終列（0 始まり）。セルが 1 つも無ければ -1。 */
  readonly maxRow: number;
  readonly maxCol: number;
  /** 既定の行の高さ（pt）。 */
  readonly defaultRowHeightPt: number;
  /** 既定の列幅（px）。 */
  readonly defaultColWidthPx: number;
  readonly cols: readonly ColumnSpec[];
  /** 結合セル。r1, c1, r2, c2 の 4 つ組の並び。 */
  readonly merges: Int32Array;
  /** 窓枠の固定（行数・列数）。無ければ null。 */
  readonly frozen: { readonly rows: number; readonly cols: number } | null;
  readonly cellCount: number;
  /** 上限で打ち切った・読めない部品があった。読めたところまでは rows に入っている。 */
  readonly problem: SheetProblem | null;
  /** 列の上限より右を捨てた。 */
  readonly columnsTruncated: boolean;
}

export type SheetKind = 'worksheet' | 'chartsheet' | 'other';
export type SheetState = 'visible' | 'hidden' | 'veryHidden';

export interface SheetInfo {
  readonly name: string;
  readonly sheetId: number;
  readonly state: SheetState;
  readonly kind: SheetKind;
  /** ワークシートで読めたもの。グラフシート等・読めなかったものは null。 */
  readonly data: SheetData | null;
  readonly problem: SheetProblem | null;
}

export interface Workbook {
  readonly sheets: readonly SheetInfo[];
  /** 共有文字列。 */
  readonly sst: readonly string[];
  /** 1904 年起点の日付か（Mac の旧 Excel）。 */
  readonly date1904: boolean;
  /** `vbaProject.bin` の CRC32。マクロが無ければ null。 */
  readonly vbaCrc: number | null;
  /** 書式（styles.xml）。部品が無い・読めなければ null（すべて既定の見た目）。 */
  readonly styles: StyleTable | null;
}

export type OpenFailure =
  /** ZIP ではない（CFB でも LFS ポインタでもない）。 */
  | 'not-zip'
  /** CFB。旧形式の .xls か、パスワード付きの .xlsx。 */
  | 'encrypted-or-legacy'
  /** Git LFS のポインタ（実体が無い）。 */
  | 'lfs-pointer'
  /** ZIP だがスプレッドシートではない（.xlsb を含む）。 */
  | 'not-spreadsheet'
  | 'too-large'
  | 'broken'
  | 'empty';

export type OpenResult =
  | { readonly ok: true; readonly workbook: Workbook }
  | { readonly ok: false; readonly reason: OpenFailure };
