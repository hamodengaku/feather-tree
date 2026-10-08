/*
 * シート XML の書き換え（docs/07-xlsx-cell-merge.md 4〜5 章）。
 *
 * - `<sheetData>`: 行の並び（OutRow）が渡されたら、出力の行ごとに組み直す。土台の行は元のバイトを使い、
 *   行番号・セル番地・数式だけを付け替える。相手側を採ったセルは相手側から書き、相手側の行は挿入する。
 *   並びが無ければ（このシートは採っていない）、数式の付け替えだけをその場で当てる
 * - それ以外: 行を変えたシートなら、範囲を持つ要素（結合・条件付き書式・入力規則・リンク・フィルタ・選択・
 *   改ページ・保護範囲・エラー無視・拡張の sqref）を付け替える。消えた範囲だけの要素は取り除く
 * - 数式（条件付き書式・入力規則・拡張の `xm:f` を含む）は、行を変えたシートを指していれば付け替える
 *
 * 共有数式: 行を変えたシートでは全部、他のシートでは親が行を変えたシートを指すものを、普通の数式に展開する
 * （挿入・削除をまたぐ共有数式は「親からの位置の差」で本文を作る仕組みと噛み合わない）。
 */

import { cellAddress } from '../sheet/ref.js';
import { FORMULA_ARRAY, FORMULA_DATA_TABLE, type CellData, type RowData, type SheetData } from '../model/types.js';
import { decodeUtf8 } from '../text/utf8.js';
import { MAX_ROWS } from '../sheet/ref.js';
import { XML_END, XML_EOF, XML_START, XML_TEXT, XmlScanner } from '../xml/scanner.js';
import { cellXml, type CellWrite } from './cells.js';
import { ByteEdits, escapeXmlAttr, escapeXmlText } from './edits.js';
import { remapFormula, remapRefText, remapSqref, type FormulaContext, type RowMap } from './refs.js';
import type { StyleImporter } from './styles.js';

/** 出力の 1 行。並び順がそのまま新しい行番号（0 始まり）になる。 */
export type OutRow =
  /** 土台の行を残す。theirsCols の列だけ相手側の行（theirsRow）のセルに差し替える。 */
  | { readonly kind: 'ours'; readonly row: number; readonly theirsRow: number; readonly theirsCols: ReadonlySet<number> }
  /** 相手側の行を挿入する。 */
  | { readonly kind: 'theirs'; readonly row: number };

export interface TheirsSide {
  readonly data: SheetData;
  readonly sst: readonly string[];
  readonly sstRaw: readonly string[];
  /** 相手側の座標 → 新しい座標。sheet は相手側のシート名。 */
  readonly ctx: FormulaContext;
  readonly styles: StyleImporter;
}

/** 書いたセル（照合用）。row は新しい行番号。 */
export interface WrittenCell {
  readonly row: number;
  readonly col: number;
  readonly side: 'ours' | 'theirs';
  readonly source: CellData;
  /** 書いた数式（付け替え後）。無ければ null。 */
  readonly formula: string | null;
}

export interface SheetRewriteInput {
  readonly xml: Uint8Array;
  readonly data: SheetData;
  /** null なら行・セルは変えない（数式の付け替えだけ）。 */
  readonly rows: readonly OutRow[] | null;
  /** このシートの「土台の行 → 新しい行」。 */
  readonly rowMap: RowMap;
  /** 土台の数式の付け替え（sheet はこのシートの名前）。 */
  readonly ctx: FormulaContext;
  readonly theirs: TheirsSide | null;
  /** 書いたセルを知らせる（rows があるときだけ）。 */
  readonly onWritten?: (cell: WrittenCell) => void;
}

/** 書き換えられない形だった。 */
export class SheetRewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetRewriteError';
  }
}

interface CellEl {
  readonly col: number;
  readonly start: number;
  readonly end: number;
}

interface RowEl {
  readonly row: number;
  readonly start: number;
  readonly end: number;
  readonly tagEnd: number;
  readonly selfClosing: boolean;
  readonly cells: CellEl[];
  /** 最後のセルの後ろから </row> の前まで（extLst など）。 */
  readonly tailStart: number;
  readonly closeStart: number;
}

function cellAt(row: RowData | undefined, col: number): CellData | undefined {
  return row?.cells.find((c) => c.col === col);
}

/** `<c r="...">` の列（無ければ直前の列 + 1）。 */
function cellColumn(x: XmlScanner, fallback: number): number {
  const ref = x.attr('r');
  if (ref === null) return fallback;
  let col = 0;
  let i = 0;
  while (i < ref.length) {
    const c = ref.charCodeAt(i) & ~0x20;
    if (c < 65 || c > 90) break;
    col = col * 26 + (c - 64);
    i += 1;
  }
  return i === 0 ? fallback : col - 1;
}

function collectRows(bytes: Uint8Array, start: number, end: number): Map<number, RowEl> {
  const rows = new Map<number, RowEl>();
  const x = new XmlScanner(bytes, start, end);
  let nextRow = 0;
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k !== XML_START) continue;
    if (!x.nameIs('row')) {
      x.skipElement();
      continue;
    }
    const r = x.attrInt('r', 0);
    const row = r >= 1 ? r - 1 : nextRow;
    nextRow = row + 1;
    const rowStart = x.tokenStart;
    const tagEnd = x.tokenEnd;
    if (x.selfClosing) {
      rows.set(row, { row, start: rowStart, end: tagEnd, tagEnd, selfClosing: true, cells: [], tailStart: tagEnd, closeStart: tagEnd });
      continue;
    }
    const cells: CellEl[] = [];
    let nextCol = 0;
    let tailStart = tagEnd;
    let closeStart = end;
    let rowEnd = end;
    for (let c = x.next(); c !== XML_EOF; c = x.next()) {
      if (c === XML_END) {
        closeStart = x.tokenStart;
        rowEnd = x.tokenEnd;
        break;
      }
      if (c !== XML_START) continue;
      if (!x.nameIs('c')) {
        x.skipElement();
        continue;
      }
      const col = cellColumn(x, nextCol);
      nextCol = col + 1;
      const cellStart = x.tokenStart;
      x.skipElement();
      cells.push({ col, start: cellStart, end: x.position });
      tailStart = x.position;
    }
    if (rows.has(row)) throw new SheetRewriteError('同じ行番号の行が 2 つあるシートは書き換えられません。');
    rows.set(row, { row, start: rowStart, end: rowEnd, tagEnd, selfClosing: false, cells, tailStart, closeStart });
  }
  return rows;
}

/** 共有数式の親（`<f t="shared" ref=…>本文</f>`）の si と本文を集める。 */
function sharedMasters(bytes: Uint8Array, start: number, end: number): Map<string, string> {
  const out = new Map<string, string>();
  const x = new XmlScanner(bytes, start, end);
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k !== XML_START || !x.nameIs('f') || x.selfClosing) continue;
    if (x.attr('t') !== 'shared' || !x.attrRaw('ref')) continue;
    const si = x.attr('si');
    const text = x.readElementText();
    if (si !== null) out.set(si, text);
  }
  return out;
}

export function rewriteSheet(input: SheetRewriteInput): Uint8Array {
  const bytes = input.xml;
  const { rowMap, ctx } = input;
  const structural = !rowMap.identity;
  const formulasMove = ctx.anyChanged;
  if (input.rows === null && !structural && !formulasMove) return bytes;

  // sheetData の位置
  let sdTagStart = -1;
  let sdTagEnd = -1;
  let sdSelf = false;
  let sdInnerEnd = -1;
  let sdEnd = -1;
  {
    const x = new XmlScanner(bytes);
    for (let k = x.next(); k !== XML_EOF; k = x.next()) {
      if (k === XML_START && x.nameIs('sheetData')) {
        sdTagStart = x.tokenStart;
        sdTagEnd = x.tokenEnd;
        sdSelf = x.selfClosing;
        if (!sdSelf) {
          // 終了タグの手前まで
          let depth = 0;
          for (let c = x.next(); c !== XML_EOF; c = x.next()) {
            if (c === XML_START && !x.selfClosing) depth += 1;
            else if (c === XML_END) {
              if (depth === 0) {
                sdInnerEnd = x.tokenStart;
                sdEnd = x.tokenEnd;
                break;
              }
              depth -= 1;
            }
          }
        } else {
          sdInnerEnd = sdTagEnd;
          sdEnd = sdTagEnd;
        }
        break;
      }
    }
  }
  if (sdTagStart < 0) throw new SheetRewriteError('シートに sheetData がありません。');

  // 展開する共有数式
  const expandSi = new Set<string>();
  const masters = sharedMasters(bytes, sdTagEnd, sdInnerEnd);
  for (const [si, text] of masters) {
    if (structural || remapFormula(text, ctx).touched) expandSi.add(si);
  }

  const edits = new ByteEdits();
  const rows = collectRows(bytes, sdTagEnd, sdInnerEnd);

  if (input.rows === null) {
    // その場で数式だけを付け替える
    for (const el of rows.values()) {
      const rowData = input.data.rows[el.row];
      for (const cell of el.cells) {
        const next = transformOursCell(bytes, cell, null, rowData, expandSi, ctx, rowMap);
        if (next !== null) edits.replace(cell.start, cell.end, next);
      }
    }
  } else {
    const content = rebuildSheetData(input, input.rows, rows, expandSi);
    if (sdSelf) edits.replace(sdTagStart, sdEnd, `<sheetData>${content}</sheetData>`);
    else edits.replace(sdTagEnd, sdInnerEnd, content);
  }

  rewriteOutsideSheetData(bytes, edits, rowMap, ctx, structural, sdTagStart, sdEnd);
  return edits.apply(bytes);
}

/**
 * 土台のセル 1 つを付け替える。変わらなければ null。
 * newRef が null なら番地はそのまま（行を変えていない）。
 */
function transformOursCell(
  bytes: Uint8Array,
  el: CellEl,
  newRef: string | null,
  rowData: RowData | undefined,
  expandSi: ReadonlySet<string>,
  ctx: FormulaContext,
  rowMap: RowMap,
): string | null {
  const slice = bytes.subarray(el.start, el.end);
  const x = new XmlScanner(slice);
  const edits = new ByteEdits();
  if (x.next() !== XML_START) return null;
  if (newRef !== null && x.attrRaw('r')) edits.replace(x.valueStart, x.valueEnd, newRef);
  if (!x.selfClosing) {
    let depth = 0;
    for (let k = x.next(); k !== XML_EOF; k = x.next()) {
      if (k === XML_END) {
        if (depth === 0) break;
        depth -= 1;
        continue;
      }
      if (k !== XML_START) continue;
      if (!x.nameIs('f')) {
        if (!x.selfClosing) depth += 1;
        continue;
      }
      const fStart = x.tokenStart;
      const type = x.attr('t');
      const si = x.attr('si');
      if (type === 'shared' && si !== null && expandSi.has(si)) {
        // 展開済みの本文（読み取り器が位置の差でずらしたもの）を、普通の数式として書く
        const expanded = cellAt(rowData, el.col)?.formula ?? null;
        x.skipElement();
        const text = expanded === null ? '' : `<f>${escapeXmlText(remapFormula(expanded, ctx).text)}</f>`;
        edits.replace(fStart, x.position, text);
        continue;
      }
      if (type === 'array' || type === 'dataTable') {
        if (x.attrRaw('ref') && !rowMap.identity) {
          const ref = decodeUtf8(slice, x.valueStart, x.valueEnd);
          const next = remapRefText(ref, rowMap);
          if (next === null) throw new SheetRewriteError('配列数式の範囲が消える行の挿入・削除は扱えません。');
          if (next !== ref) edits.replace(x.valueStart, x.valueEnd, next);
        }
      }
      if (x.selfClosing) continue;
      const t = x.next();
      if (t === XML_TEXT) {
        const text = x.text();
        const next = remapFormula(text, ctx).text;
        if (next !== text) {
          if (x.isCdata) edits.replace(x.tokenStart, x.tokenEnd, escapeXmlText(next));
          else edits.replace(x.textStart, x.textEnd, escapeXmlText(next));
        }
        x.next(); // </f>
      }
    }
  }
  if (edits.size === 0) return null;
  const out = edits.apply(slice);
  return decodeUtf8(out, 0, out.length);
}

const REF_ERROR = /#REF!/g;

/** 相手側の数式を新しい座標へ。採らなかった行を指して #REF! が増えるなら断る。 */
function theirsFormula(formula: string, ctx: FormulaContext): string {
  const next = remapFormula(formula, ctx).text;
  if ((next.match(REF_ERROR)?.length ?? 0) > (formula.match(REF_ERROR)?.length ?? 0)) {
    throw new SheetRewriteError('相手側の数式（=' + formula + '）が、採らなかった行を参照しています。参照先の行も相手側を採ってください。');
  }
  return next;
}

/** 相手側のセルを書く形にする。 */
function theirsWrite(theirs: TheirsSide, cell: CellData): CellWrite {
  if (cell.formulaKind === FORMULA_ARRAY || cell.formulaKind === FORMULA_DATA_TABLE) {
    throw new SheetRewriteError('配列数式・データテーブルのセルは相手側から写せません。');
  }
  return {
    cell,
    style: theirs.styles.importXf(cell.style),
    formula: cell.formula === null ? null : theirsFormula(cell.formula, theirs.ctx),
    sharedInner: cell.kind === 2 /* CELL_SHARED */ ? (theirs.sstRaw[cell.num] ?? null) : null,
    sharedText: cell.kind === 2 ? (theirs.sst[cell.num] ?? '') : '',
  };
}

function theirsRowTag(theirs: TheirsSide, row: RowData | undefined, rowNumber: number): string {
  let attrs = ` r="${String(rowNumber + 1)}"`;
  if (row !== undefined) {
    if (row.style >= 0) attrs += ` s="${String(theirs.styles.importXf(row.style))}" customFormat="1"`;
    if (Number.isFinite(row.heightPt)) attrs += ` ht="${String(row.heightPt)}" customHeight="1"`;
    if (row.hidden) attrs += ' hidden="1"';
  }
  return `<row${attrs}>`;
}

function rebuildSheetData(
  input: SheetRewriteInput,
  outRows: readonly OutRow[],
  rows: ReadonlyMap<number, RowEl>,
  expandSi: ReadonlySet<string>,
): string {
  const bytes = input.xml;
  const { ctx, rowMap, theirs } = input;
  const notify = input.onWritten;
  if (outRows.length > MAX_ROWS) throw new SheetRewriteError('行が多すぎて書き換えられません。');
  let out = '';

  const writeTheirs = (rowNumber: number, theirsRow: RowData | undefined, col: number): string => {
    if (theirs === null) throw new SheetRewriteError('相手側のシートがありません。');
    const cell = cellAt(theirsRow, col);
    if (cell === undefined) return '';
    const w = theirsWrite(theirs, cell);
    const xml = cellXml(cellAddress(rowNumber, col), w);
    if (xml !== '') notify?.({ row: rowNumber, col, side: 'theirs', source: cell, formula: w.formula });
    return xml;
  };

  outRows.forEach((o, rowNumber) => {
    if (o.kind === 'theirs') {
      if (theirs === null) throw new SheetRewriteError('相手側のシートがありません。');
      const theirsRow = theirs.data.rows[o.row];
      if (theirsRow === undefined) return;
      let cells = '';
      for (const cell of theirsRow.cells) cells += writeTheirs(rowNumber, theirsRow, cell.col);
      out += theirsRowTag(theirs, theirsRow, rowNumber) + cells + '</row>';
      return;
    }

    const el = rows.get(o.row);
    const rowData = input.data.rows[o.row];
    const picks = [...o.theirsCols].sort((a, b) => a - b);
    const theirsRow = picks.length > 0 && theirs !== null ? theirs.data.rows[o.theirsRow] : undefined;

    if (el === undefined) {
      if (picks.length === 0) return;
      let cells = '';
      for (const col of picks) cells += writeTheirs(rowNumber, theirsRow, col);
      if (cells !== '') out += `<row r="${String(rowNumber + 1)}">${cells}</row>`;
      return;
    }

    // 開始タグ: 行番号を付け替える。セルを足すなら spans（任意の手掛かり）を落とす
    const tagBytes = bytes.subarray(el.start, el.tagEnd);
    const tx = new XmlScanner(tagBytes);
    tx.next();
    const tagEdits = new ByteEdits();
    if (tx.attrRaw('r')) tagEdits.replace(tx.valueStart, tx.valueEnd, String(rowNumber + 1));
    else tagEdits.insert(tx.nameEnd, ` r="${String(rowNumber + 1)}"`);
    if (picks.length > 0 && tx.attrRaw('spans')) {
      // ` spans="..."` を属性名の前の空白ごと消す
      let s = tx.valueStart;
      while (s > 0 && tagBytes[s - 1] !== 0x20) s -= 1;
      tagEdits.remove(s - 1, tx.valueEnd + 1);
    }
    const tagOut = tagEdits.apply(tagBytes);
    let tag = decodeUtf8(tagOut, 0, tagOut.length);

    const moved = rowNumber !== o.row;
    const keptCell = (cell: CellEl): string => {
      const newRef = moved ? cellAddress(rowNumber, cell.col) : null;
      const next = transformOursCell(bytes, cell, newRef, rowData, expandSi, ctx, rowMap);
      const source = cellAt(rowData, cell.col);
      if (source !== undefined) {
        notify?.({ row: rowNumber, col: cell.col, side: 'ours', source, formula: source.formula === null ? null : remapFormula(source.formula, ctx).text });
      }
      return next ?? decodeUtf8(bytes, cell.start, cell.end);
    };

    if (el.selfClosing) {
      if (picks.length === 0) {
        out += tag;
        return;
      }
      tag = tag.replace(/\s*\/>$/, '>');
      let cells = '';
      for (const col of picks) cells += writeTheirs(rowNumber, theirsRow, col);
      out += tag + cells + '</row>';
      return;
    }

    let body = decodeUtf8(bytes, el.tagEnd, el.cells[0]?.start ?? el.tailStart);
    let p = 0;
    for (const cell of el.cells) {
      while (p < picks.length && (picks[p] ?? 0) < cell.col) {
        body += writeTheirs(rowNumber, theirsRow, picks[p] ?? 0);
        p += 1;
      }
      if (p < picks.length && picks[p] === cell.col) {
        body += writeTheirs(rowNumber, theirsRow, cell.col);
        p += 1;
        continue;
      }
      body += keptCell(cell);
    }
    while (p < picks.length) {
      body += writeTheirs(rowNumber, theirsRow, picks[p] ?? 0);
      p += 1;
    }
    out += tag + body + decodeUtf8(bytes, el.tailStart, el.end);
  });
  return out;
}

/** 消せる要素の入れ物（全部消えたら入れ物ごと消す）。 */
interface Container {
  readonly name: string;
  readonly start: number;
  readonly count: readonly [number, number] | null;
  kept: number;
  readonly removed: [number, number][];
}

const CONTAINERS: Readonly<Record<string, string>> = {
  mergeCells: 'mergeCell',
  dataValidations: 'dataValidation',
  hyperlinks: 'hyperlink',
  ignoredErrors: 'ignoredError',
  protectedRanges: 'protectedRange',
};

function rewriteOutsideSheetData(
  bytes: Uint8Array,
  edits: ByteEdits,
  rowMap: RowMap,
  ctx: FormulaContext,
  structural: boolean,
  sdStart: number,
  sdEnd: number,
): void {
  if (!structural && !ctx.anyChanged) return;
  const x = new XmlScanner(bytes);
  const stack: string[] = [];
  const containers: Container[] = [];
  const attr = (name: string): string | null => (x.attrRaw(name) ? decodeUtf8(bytes, x.valueStart, x.valueEnd) : null);
  const setAttr = (value: string): void => edits.replace(x.valueStart, x.valueEnd, escapeXmlAttr(value));

  /** 範囲属性を付け替える。消えたら true（呼び出し側が要素を取り除く）。 */
  const remapAttr = (name: string, sqref: boolean): boolean => {
    const value = attr(name);
    if (value === null) return false;
    const next = sqref ? remapSqref(value, rowMap) : remapRefText(value, rowMap);
    if (next === null) return true;
    if (next !== value && x.attrRaw(name)) setAttr(next);
    return false;
  };

  /** 今の要素を取り除く（入れ物の中なら入れ物へ預ける）。 */
  const removeCurrent = (): void => {
    const start = x.tokenStart;
    x.skipElement();
    const range: [number, number] = [start, x.position];
    const top = containers[containers.length - 1];
    if (top !== undefined && stack[stack.length - 1] === top.name) top.removed.push(range);
    else edits.remove(range[0], range[1]);
  };

  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k === XML_END) {
      const name = stack.pop();
      const top = containers[containers.length - 1];
      if (top !== undefined && name === top.name) {
        containers.pop();
        if (top.kept === 0 && top.removed.length > 0) {
          edits.remove(top.start, x.tokenEnd);
        } else {
          for (const [s, e] of top.removed) edits.remove(s, e);
          if (top.count !== null && top.removed.length > 0) edits.replace(top.count[0], top.count[1], String(top.kept));
        }
      }
      continue;
    }
    if (k === XML_TEXT) {
      const parent = stack[stack.length - 1];
      if (parent === 'formula' || parent === 'formula1' || parent === 'formula2' || parent === 'f') {
        const text = x.text();
        const next = remapFormula(text, ctx).text;
        if (next !== text) edits.replace(x.isCdata ? x.tokenStart : x.textStart, x.isCdata ? x.tokenEnd : x.textEnd, escapeXmlText(next));
      } else if (parent === 'sqref' && structural) {
        const text = x.text();
        const next = remapSqref(text, rowMap);
        if (next === null) throw new SheetRewriteError('拡張の範囲（xm:sqref）が消える行の削除は扱えません。');
        if (next !== text) edits.replace(x.textStart, x.textEnd, escapeXmlText(next));
      }
      continue;
    }
    if (k !== XML_START) continue;
    if (x.tokenStart === sdStart) {
      // sheetData は別に組み直してある
      x.skipElement();
      if (x.position < sdEnd) throw new SheetRewriteError('sheetData の範囲が読み違えられました。');
      continue;
    }
    const name = decodeUtf8(bytes, x.nameStart, x.nameEnd);

    if (structural) {
      const containerChild = Object.values(CONTAINERS).includes(name);
      switch (name) {
        case 'dimension': {
          const v = attr('ref');
          if (v !== null) setAttr(remapRefText(v, rowMap) ?? 'A1');
          break;
        }
        case 'mergeCell':
        case 'hyperlink':
          if (remapAttr('ref', false)) {
            removeCurrent();
            continue;
          }
          break;
        case 'dataValidation':
        case 'ignoredError':
        case 'protectedRange':
        case 'conditionalFormatting':
          if (remapAttr('sqref', true)) {
            removeCurrent();
            continue;
          }
          break;
        case 'autoFilter':
        case 'sortState':
        case 'sortCondition':
          if (remapAttr('ref', false)) {
            removeCurrent();
            continue;
          }
          break;
        case 'selection': {
          const active = attr('activeCell');
          if (active !== null) setAttr(remapRefText(active, rowMap) ?? 'A1');
          const sq = attr('sqref');
          if (sq !== null) setAttr(remapSqref(sq, rowMap) ?? 'A1');
          break;
        }
        case 'pane': {
          const top = attr('topLeftCell');
          if (top !== null) {
            const next = remapRefText(top, rowMap);
            if (next !== null && next !== top) setAttr(next);
          }
          break;
        }
        case 'brk':
          if (stack[stack.length - 1] === 'rowBreaks') {
            const id = attr('id');
            const n = id === null ? NaN : Number(id);
            if (Number.isInteger(n)) {
              const moved = rowMap.range(n, MAX_ROWS - 1)?.[0];
              if (moved !== undefined && moved !== n && x.attrRaw('id')) setAttr(String(moved));
            }
          }
          break;
        default:
          break;
      }
      if (containerChild) {
        const top = containers[containers.length - 1];
        if (top !== undefined && stack[stack.length - 1] === top.name) top.kept += 1;
      }
      const containerName = Object.keys(CONTAINERS).find((c) => c === name);
      if (containerName !== undefined && !x.selfClosing) {
        containers.push({
          name,
          start: x.tokenStart,
          count: x.attrRaw('count') ? [x.valueStart, x.valueEnd] : null,
          kept: 0,
          removed: [],
        });
      }
    }
    if (!x.selfClosing) stack.push(name);
  }
}

