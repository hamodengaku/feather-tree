/*
 * `@feathertree/excel` — Excel ファイル（.xlsx / .xlsm）を読んで新旧を比べる純関数の層（決定 33）。
 *
 * **git も Electron も Node も知らない。** バイト列を入れるとモデルと比較結果が出るだけで、
 * I/O も描画も持たない（`.dependency-cruiser.cjs` の `no-upward-from-excel` / `no-node-in-excel`）。
 * ZIP の deflate の展開だけは、呼び出し側から `Inflater` を注入してもらう。
 */

export { DEFAULT_LIMITS, NEVER_CANCELLED, type CancelToken, type ExcelLimits } from './limits.js';
export { sniffExcel, type ExcelSniff } from './sniff.js';
export {
  METHOD_DEFLATE,
  METHOD_STORED,
  openZip,
  readZipEntry,
  type InflateResult,
  type Inflater,
  type ZipArchive,
  type ZipEntry,
} from './zip/reader.js';

export {
  CELL_BLANK,
  CELL_BOOL,
  CELL_DATE,
  CELL_ERROR,
  CELL_FORMULA_STR,
  CELL_INLINE,
  CELL_NUMBER,
  CELL_SHARED,
  FORMULA_ARRAY,
  FORMULA_DATA_TABLE,
  FORMULA_NONE,
  FORMULA_NORMAL,
  FORMULA_SHARED,
  type CellData,
  type CellKind,
  type ColumnSpec,
  type FormulaKind,
  type OpenFailure,
  type OpenResult,
  type RowData,
  type SheetData,
  type SheetInfo,
  type SheetKind,
  type SheetProblem,
  type SheetState,
  type Workbook,
} from './model/types.js';

export { openWorkbook, openWorkbookSteps } from './workbook/workbook.js';
export { cellAddress, columnName, parseCellRef, parseRange, MAX_COLS, MAX_ROWS, type CellRange, type CellRef } from './sheet/ref.js';
export { columnWidthPx, rowHeightPx, DEFAULT_COL_WIDTH_PX, DEFAULT_ROW_HEIGHT_PT } from './sheet/worksheet.js';
export { shiftFormula } from './formula/shared.js';
export { formatGeneral } from './format/general.js';
export { formatNumber, formatTextValue, isDateFormat } from './format/numFmt.js';
export { builtinFormat } from './format/builtin.js';
export { eraOf, isoToSerial, serialToParts, type DateParts } from './format/date.js';
export {
  parseStyles,
  type BorderEdge,
  type BorderStyle,
  type CellStyle,
  type HorizontalAlign,
  type StyleTable,
  type VerticalAlign,
} from './style/styles.js';
export { parseTheme } from './style/theme.js';
export { applyTint, DEFAULT_INDEXED, DEFAULT_THEME, normalizeRgb, resolveColor, themeSlot, type ColorSpec } from './style/colors.js';

export {
  VALUE_BOOL,
  VALUE_DATE,
  VALUE_EMPTY,
  VALUE_ERROR,
  VALUE_NUMBER,
  VALUE_TEXT,
  cellsEqual,
  displayText,
  formatContextOf,
  formattedText,
  rawText,
  type FormatContext,
} from './compare/cells.js';
export { alignRows, type Alignment } from './compare/align.js';
export {
  ROW_ADDED,
  ROW_CHANGED,
  ROW_REMOVED,
  ROW_SAME,
  compareWorkbooks,
  compareWorkbooksSteps,
  type SheetComparison,
  type SheetMark,
  type WorkbookComparison,
} from './compare/compare.js';
export { HIDDEN_NEW, HIDDEN_OLD, buildGeometry, type SheetGeometry } from './compare/geometry.js';
export { buildRowPage, cellDetail, type CellDetail, type CellSide, type RowPageEntry, type RowSide } from './compare/pages.js';
export {
  buildRowDiff,
  type RowDiff,
  type RowDiffHunk,
  type RowDiffKind,
  type RowDiffRow,
  type RowDiffSheet,
} from './compare/hunks.js';

/** Excel 差分モードが解釈できる拡張子（小文字）。1 か所で決める。 */
export const EXCEL_OPENABLE_EXTENSIONS = ['.xlsx', '.xlsm', '.xltx', '.xltm'] as const;
/** 一覧には出すが「表示できません」の案内だけを出す拡張子。 */
export const EXCEL_LISTED_ONLY_EXTENSIONS = ['.xls', '.xlsb'] as const;
