/*
 * ワークシート（`xl/worksheets/sheetN.xml`）の読み取り（決定 33）。
 *
 * 読むもの: `sheetFormatPr`（既定の行の高さ・列幅）、`cols`、`sheetData` の行とセル、`mergeCells`、
 * `sheetView` の `pane`（窓枠の固定）。条件付き書式・入力規則・図形などは読まない。
 *
 * 行の `r`・セルの `r` は省略されうる（そのときは直前の続き）。行・セルの順序が崩れていても
 * 読めるように、最後に並べ直す。
 *
 * **上限で打ち切る。** セル数が上限に達したら、そこまでで読むのをやめて `problem: 'too-large'` を立てる
 * （読めた行は返す）。列の上限より右のセルは捨てて `columnsTruncated` を立てる。
 */

import { shiftFormula } from '../formula/shared.js';
import {
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
  type CellKind,
  type ColumnSpec,
  type FormulaKind,
  type RowData,
  type SheetData,
  type SheetProblem,
} from '../model/types.js';
import { parseRange, parseCellRefBytes, MAX_ROWS } from './ref.js';
import { readStringItem } from '../workbook/sst.js';
import { unescapeOoxml } from '../xml/entities.js';
import { XML_END, XML_EOF, XML_START, XmlScanner } from '../xml/scanner.js';

export interface WorksheetOptions {
  readonly maxCells: number;
  readonly maxColumns: number;
  /** 行要素の数の上限（セルの無い行も数える）。 */
  readonly maxRows: number;
}

/** Excel の既定（Calibri 11pt）。 */
export const DEFAULT_ROW_HEIGHT_PT = 15;
/** 既定の列幅（8.43 文字 = 64px）。 */
export const DEFAULT_COL_WIDTH_PX = 64;
/** 既定フォントの最大の数字の幅（Calibri 11pt で 7px）。列幅の換算に使う。 */
const MAX_DIGIT_WIDTH = 7;

/**
 * ファイルの列幅（文字数。余白を含む）→ px。ECMA-376 の換算式
 * `Truncate(((256 * width + Truncate(128 / MDW)) / 256) * MDW)`（MDW は最大の数字の幅）。
 */
export function columnWidthPx(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.trunc(((256 * width + Math.trunc(128 / MAX_DIGIT_WIDTH)) / 256) * MAX_DIGIT_WIDTH);
}

/** 行の高さ（pt）→ px（96dpi）。 */
export function rowHeightPx(pt: number): number {
  return Math.round((pt * 4) / 3);
}

/** `t` 属性の値。 */
const T_NUMBER = 0;
const T_SHARED = 1;
const T_BOOL = 2;
const T_ERROR = 3;
const T_STR = 4;
const T_INLINE = 5;
const T_DATE = 6;

interface MutableCell {
  col: number;
  kind: CellKind;
  num: number;
  text: string | null;
  formula: string | null;
  formulaKind: FormulaKind;
  style: number;
}

interface MutableRow {
  row: number;
  heightPt: number;
  hidden: boolean;
  style: number;
  cells: MutableCell[];
}

interface SharedMaster {
  readonly row: number;
  readonly col: number;
  readonly text: string;
}

interface PendingShared {
  readonly cell: MutableCell;
  readonly row: number;
  readonly si: number;
}

export function parseWorksheet(bytes: Uint8Array, options: WorksheetOptions): SheetData {
  const x = new XmlScanner(bytes);
  const rows: (MutableRow | undefined)[] = [];
  const cols: ColumnSpec[] = [];
  const merges: number[] = [];
  const masters = new Map<number, SharedMaster>();
  const pending: PendingShared[] = [];

  let defaultRowHeightPt = DEFAULT_ROW_HEIGHT_PT;
  let defaultColWidth = NaN;
  let baseColWidth = NaN;
  let frozen: { rows: number; cols: number } | null = null;
  let cellCount = 0;
  let rowCount = 0;
  let problem: SheetProblem | null = null;
  let columnsTruncated = false;
  let nextRow = 0;
  let unsorted = false;
  let lastRow = -1;

  outer: for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k !== XML_START) continue;

    if (x.nameIs('row')) {
      const r = x.attrInt('r', 0);
      const row = r >= 1 && r <= MAX_ROWS ? r - 1 : nextRow;
      // 行数の上限（Excel の最大行、または設定の上限）。r の無い空の <row/> を延々と並べた入力で、
      // セル数の上限に掛からないまま行だけが増え続けるのを止める
      if (row >= MAX_ROWS || rowCount >= options.maxRows) {
        problem = 'too-large';
        break;
      }
      if (rows[row] === undefined) rowCount += 1;
      nextRow = row + 1;
      if (row < lastRow) unsorted = true;
      lastRow = row;
      const heightPt = x.attrNumber('ht', NaN);
      const hidden = x.attrBool('hidden', false);
      // 行の書式は customFormat="1" のときだけ効く（s だけでは効かない。ECMA-376 §18.3.1.73）
      const style = x.attrBool('customFormat', false) ? Math.max(-1, x.attrInt('s', -1)) : -1;
      let target = rows[row];
      if (target === undefined) {
        target = { row, heightPt, hidden, style, cells: [] };
        rows[row] = target;
      }
      if (x.selfClosing) continue;

      let nextCol = 0;
      let lastCol = -1;
      for (let rk = x.next(); rk !== XML_EOF; rk = x.next()) {
        if (rk === XML_END) break; // </row>
        if (rk !== XML_START) continue;
        if (!x.nameIs('c')) {
          x.skipElement();
          continue;
        }
        const cell = readCell(x, nextCol, masters, pending, row);
        nextCol = cell.col + 1;
        if (cell.col >= options.maxColumns) {
          columnsTruncated = true;
          continue;
        }
        if (cell.kind === CELL_BLANK && cell.formula === null && cell.style === 0 && cell.formulaKind === FORMULA_NONE) {
          continue;
        }
        // 上限を超える 1 個目で打ち切る（ちょうど上限の個数のシートは読み切れている）
        if (cellCount >= options.maxCells) {
          problem = 'too-large';
          break outer;
        }
        if (cell.col <= lastCol) unsorted = true;
        lastCol = Math.max(lastCol, cell.col);
        target.cells.push(cell);
        cellCount += 1;
      }
      continue;
    }

    if (x.nameIs('sheetFormatPr')) {
      defaultRowHeightPt = x.attrNumber('defaultRowHeight', DEFAULT_ROW_HEIGHT_PT);
      defaultColWidth = x.attrNumber('defaultColWidth', NaN);
      baseColWidth = x.attrNumber('baseColWidth', NaN);
      continue;
    }
    if (x.nameIs('col')) {
      const min = x.attrInt('min', 0);
      const max = x.attrInt('max', 0);
      if (min >= 1 && max >= min) {
        cols.push({
          min: min - 1,
          max: Math.min(max, options.maxColumns) - 1,
          widthPx: columnWidthPx(x.attrNumber('width', NaN)) || NaN,
          hidden: x.attrBool('hidden', false),
          style: Math.max(-1, x.attrInt('style', -1)),
        });
      }
      continue;
    }
    if (x.nameIs('pane')) {
      const state = x.attr('state');
      if (state === 'frozen' || state === 'frozenSplit') {
        frozen = { rows: Math.max(0, x.attrInt('ySplit', 0)), cols: Math.max(0, x.attrInt('xSplit', 0)) };
      }
      continue;
    }
    if (x.nameIs('mergeCell')) {
      const ref = x.attr('ref');
      const range = ref === null ? null : parseRange(ref);
      if (range !== null) merges.push(range.r1, range.c1, range.r2, range.c2);
      continue;
    }
  }

  // 先頭より前に現れた共有数式の従属セル（順序が崩れたファイル）を、ここで埋める
  for (const p of pending) {
    const master = masters.get(p.si);
    if (master !== undefined) p.cell.formula = shiftFormula(master.text, p.row - master.row, p.cell.col - master.col);
  }

  let maxRow = -1;
  let maxCol = -1;
  const out: (RowData | undefined)[] = new Array<RowData | undefined>(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;
    if (unsorted) row.cells.sort((a, b) => a.col - b.col);
    out[i] = row;
    maxRow = i;
    const last = row.cells[row.cells.length - 1];
    if (last !== undefined && last.col > maxCol) maxCol = last.col;
  }
  out.length = maxRow + 1;

  // defaultColWidth は余白込みの文字数、baseColWidth は余白抜きの文字数（既定 8 = 64px）
  const widthPx = Number.isFinite(defaultColWidth) && defaultColWidth > 0
    ? columnWidthPx(defaultColWidth)
    : Number.isFinite(baseColWidth) && baseColWidth > 0
      ? Math.round(baseColWidth * (DEFAULT_COL_WIDTH_PX / 8))
      : DEFAULT_COL_WIDTH_PX;

  return {
    rows: out,
    maxRow,
    maxCol,
    defaultRowHeightPt: Number.isFinite(defaultRowHeightPt) && defaultRowHeightPt > 0 ? defaultRowHeightPt : DEFAULT_ROW_HEIGHT_PT,
    defaultColWidthPx: widthPx,
    cols,
    merges: Int32Array.from(merges),
    frozen,
    cellCount,
    problem,
    columnsTruncated,
  };
}

function readType(x: XmlScanner): number {
  if (!x.attrRaw('t')) return T_NUMBER;
  const b = x.bytes;
  const s = x.valueStart;
  const len = x.valueEnd - s;
  const c0 = b[s];
  if (len === 1) {
    if (c0 === 0x73) return T_SHARED; // s
    if (c0 === 0x62) return T_BOOL; // b
    if (c0 === 0x65) return T_ERROR; // e
    if (c0 === 0x64) return T_DATE; // d
    return T_NUMBER; // n
  }
  if (len === 3 && c0 === 0x73) return T_STR; // str
  if (len === 9 && c0 === 0x69) return T_INLINE; // inlineStr
  return T_NUMBER;
}

function readCell(
  x: XmlScanner,
  nextCol: number,
  masters: Map<number, SharedMaster>,
  pending: PendingShared[],
  row: number,
): MutableCell {
  let col = nextCol;
  if (x.attrRaw('r')) {
    const ref = parseCellRefBytes(x.bytes, x.valueStart, x.valueEnd);
    if (ref !== null && ref.col >= 0) col = ref.col;
  }
  const style = Math.max(0, x.attrInt('s', 0));
  const type = readType(x);

  const cell: MutableCell = {
    col,
    kind: CELL_BLANK,
    num: 0,
    text: null,
    formula: null,
    formulaKind: FORMULA_NONE,
    style,
  };
  if (x.selfClosing) return cell;

  let value: string | null = null;
  let inline: string | null = null;
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k === XML_END) break; // </c>
    if (k !== XML_START) continue;
    if (x.nameIs('v')) {
      value = x.readElementText();
    } else if (x.nameIs('f')) {
      readFormula(x, cell, masters, pending, row);
    } else if (x.nameIs('is')) {
      inline = x.selfClosing ? '' : readStringItem(x);
    } else {
      x.skipElement();
    }
  }

  switch (type) {
    case T_SHARED: {
      const index = value === null ? NaN : Number.parseInt(value, 10);
      if (Number.isInteger(index) && index >= 0) {
        cell.kind = CELL_SHARED;
        cell.num = index;
      }
      break;
    }
    case T_BOOL:
      if (value !== null) {
        cell.kind = CELL_BOOL;
        cell.num = value.trim() === '1' || value.trim() === 'true' ? 1 : 0;
      }
      break;
    case T_ERROR:
      if (value !== null) {
        cell.kind = CELL_ERROR;
        cell.text = value;
      }
      break;
    case T_STR:
      if (value !== null) {
        cell.kind = CELL_FORMULA_STR;
        cell.text = unescapeOoxml(value);
      }
      break;
    case T_INLINE:
      if (inline !== null) {
        cell.kind = CELL_INLINE;
        cell.text = inline;
      }
      break;
    case T_DATE:
      if (value !== null) {
        cell.kind = CELL_DATE;
        cell.text = value;
      }
      break;
    default:
      if (value !== null && value.trim() !== '') {
        const n = Number(value);
        if (Number.isFinite(n)) {
          cell.kind = CELL_NUMBER;
          cell.num = n;
        } else {
          // 数値のはずが読めない。捨てずに文字として残す
          cell.kind = CELL_INLINE;
          cell.text = value;
        }
      }
      break;
  }
  return cell;
}

function readFormula(
  x: XmlScanner,
  cell: MutableCell,
  masters: Map<number, SharedMaster>,
  pending: PendingShared[],
  row: number,
): void {
  const t = x.attr('t');
  const si = x.attrInt('si', -1);
  const text = x.selfClosing ? '' : x.readElementText();

  if (t === 'shared') {
    cell.formulaKind = FORMULA_SHARED;
    if (text !== '') {
      cell.formula = text;
      if (si >= 0 && !masters.has(si)) masters.set(si, { row, col: cell.col, text });
      return;
    }
    const master = si >= 0 ? masters.get(si) : undefined;
    if (master !== undefined) {
      cell.formula = shiftFormula(master.text, row - master.row, cell.col - master.col);
    } else if (si >= 0) {
      pending.push({ cell, row, si });
    }
    return;
  }
  if (t === 'array') {
    cell.formulaKind = FORMULA_ARRAY;
    cell.formula = text === '' ? null : text;
    return;
  }
  if (t === 'dataTable') {
    cell.formulaKind = FORMULA_DATA_TABLE;
    return;
  }
  if (text !== '') {
    cell.formulaKind = FORMULA_NORMAL;
    cell.formula = text;
  }
}

/** 列の仕様を 0 始まりの列番号で引く。 */
export function columnSpecAt(cols: readonly ColumnSpec[], col: number): ColumnSpec | undefined {
  for (const spec of cols) {
    if (col >= spec.min && col <= spec.max) return spec;
  }
  return undefined;
}

