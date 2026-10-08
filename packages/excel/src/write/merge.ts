/*
 * ブックのセル単位の採用の組み立て（docs/07-xlsx-cell-merge.md）。
 *
 * 自分側（土台）の ZIP を元に、
 *   1. シートごとに sheetData と範囲を持つ要素を書き換え（sheet.ts）
 *   2. 行を変えたシートのテーブル・図・コメント、グラフ・ピボットのキャッシュ、名前の定義を付け替え（parts.ts）
 *   3. 相手側の書式を styles.xml へ足し込み（styles.ts）、計算順序（calcChain）を消して再計算を立てる
 *   4. 変えない部品は圧縮済みのまま写して ZIP を書く（zipWriter.ts）
 *   5. **書いたブックを読み取り器で開き直し、書いたセルが狙いどおりかを照合する**（違えば投げる）
 *
 * 採り方（どの行を残し、どのセルを相手側から採るか）は呼び出し側（core）が決めて渡す。
 */

import { DEFAULT_LIMITS } from '../limits.js';
import { cellsEqual } from '../compare/cells.js';
import type { CellData, SheetData, Workbook } from '../model/types.js';
import type { StyleTable } from '../style/styles.js';
import { openWorkbook } from '../workbook/workbook.js';
import type { Inflater } from '../zip/reader.js';
import { cellAddress } from '../sheet/ref.js';
import { rawSharedStringItems } from './cells.js';
import { openPackage, ROW_SAFE_RELATIONS, type XlsxPackage } from './package.js';
import {
  removeContentTypeOverride,
  removeRelationship,
  rewriteChartPart,
  rewriteCommentsPart,
  rewriteDrawingPart,
  rewritePivotCachePart,
  rewriteTablePart,
  rewriteVmlPart,
  rewriteWorkbookPart,
} from './parts.js';
import { buildRowMap, IDENTITY_MAP, UnsupportedReferenceError, type FormulaContext, type RowMap } from './refs.js';
import { rewriteSheet, SheetRewriteError, type OutRow, type TheirsSide, type WrittenCell } from './sheet.js';
import { StyleImporter, StyleImportError } from './styles.js';
import { writeZip, type Deflater, type ZipWriteItem } from './zipWriter.js';

/** 1 シートぶんの採り方。土台にあるシート（対になったシート）だけを渡す。 */
export interface XlsxSheetMerge {
  readonly oursName: string;
  readonly theirsName: string;
  /** 出力の行の並び。null ならこのシートは採っていない（行もセルも土台のまま）。 */
  readonly rows: readonly OutRow[] | null;
  /** 土台の行 → 新しい行（消えたら -1）。表より下は tailShift だけずらす。 */
  readonly oursNewIndex: Int32Array;
  readonly oursTailShift: number;
  /** 相手側の行 → 新しい行（出さない行は -1）。 */
  readonly theirsNewIndex: Int32Array;
  readonly theirsTailShift: number;
}

export interface XlsxMergeInput {
  readonly ours: Uint8Array;
  readonly theirs: Uint8Array;
  readonly oursBook: Workbook;
  readonly theirsBook: Workbook;
  readonly sheets: readonly XlsxSheetMerge[];
  readonly inflate: Inflater;
  readonly deflate: Deflater;
}

/** 書き換えられない（理由は message）。core が ConflictUnsupportedError に読み替える。 */
export class XlsxMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxMergeError';
  }
}

const lower = (s: string): string => s.toLowerCase();

function sheetData(book: Workbook, name: string): SheetData | null {
  return book.sheets.find((s) => lower(s.name) === lower(name))?.data ?? null;
}

export function mergeXlsx(input: XlsxMergeInput): Uint8Array {
  try {
    return mergeOrThrow(input);
  } catch (err) {
    if (err instanceof SheetRewriteError || err instanceof UnsupportedReferenceError || err instanceof StyleImportError) {
      throw new XlsxMergeError(err.message);
    }
    throw err;
  }
}

function mergeOrThrow(input: XlsxMergeInput): Uint8Array {
  const ours = openPackage(input.ours, input.inflate);
  const theirs = openPackage(input.theirs, input.inflate);
  if (ours === null || theirs === null) throw new XlsxMergeError('ブックを開けませんでした。');

  // 行の対応
  const oursMaps = new Map<string, RowMap>();
  const theirsMaps = new Map<string, RowMap>();
  const byOurs = new Map<string, XlsxSheetMerge>();
  const renames = new Map<string, string>();
  for (const s of input.sheets) {
    byOurs.set(lower(s.oursName), s);
    oursMaps.set(lower(s.oursName), buildRowMap(s.oursNewIndex, s.oursTailShift));
    theirsMaps.set(lower(s.theirsName), buildRowMap(s.theirsNewIndex, s.theirsTailShift));
    renames.set(lower(s.theirsName), s.oursName);
  }
  const anyChanged = [...oursMaps.values()].some((m) => !m.identity);
  const oursCtx = (sheet: string | null): FormulaContext => ({
    sheet,
    anyChanged,
    map: (name) => oursMaps.get(lower(name)) ?? null,
  });
  const theirsCtx = (sheet: string): FormulaContext => ({
    sheet,
    // 相手側の数式は、採らなかった行を指すと #REF! になる。3D 参照も常に断る
    anyChanged: true,
    map: (name) => theirsMaps.get(lower(name)) ?? null,
    renameSheet: (name) => (renames.has(lower(name)) ? renames.get(lower(name)) : null),
  });

  // 相手側の共有文字列（<si> の中身）と書式
  const theirsSstRel = theirs.workbookRels.find((r) => r.type === 'sharedStrings' && r.target !== null);
  const theirsSstBytes = theirsSstRel?.target == null ? null : theirs.read(theirsSstRel.target);
  const sstRaw = theirsSstBytes === null ? [] : rawSharedStringItems(theirsSstBytes);
  const stylesPathOf = (pkg: XlsxPackage): string =>
    pkg.workbookRels.find((r) => r.type === 'styles' && r.target !== null)?.target ?? 'xl/styles.xml';
  const oursStylesPath = stylesPathOf(ours);
  const styles = new StyleImporter(ours.read(oursStylesPath), theirs.read(stylesPathOf(theirs)));

  const replaced = new Map<string, Uint8Array>();
  const written = new Map<string, WrittenCell[]>();

  for (const part of ours.sheets) {
    const plan = byOurs.get(lower(part.name));
    const rowMap = oursMaps.get(lower(part.name)) ?? IDENTITY_MAP;
    if (plan?.rows == null && !anyChanged) continue;
    const xml = ours.read(part.path);
    const data = sheetData(input.oursBook, part.name);
    if (xml === null || data === null) throw new XlsxMergeError(`シート「${part.name}」を読めませんでした。`);

    let theirsSide: TheirsSide | null = null;
    if (plan?.rows != null) {
      const theirsData = sheetData(input.theirsBook, plan.theirsName);
      if (theirsData === null) throw new XlsxMergeError(`相手側のシート「${plan.theirsName}」を読めませんでした。`);
      theirsSide = { data: theirsData, sst: input.theirsBook.sst, sstRaw, ctx: theirsCtx(plan.theirsName), styles };
    }

    if (!rowMap.identity) {
      const unsafe = part.rels.filter((r) => !ROW_SAFE_RELATIONS.has(r.type)).map((r) => r.type);
      if (unsafe.length > 0) {
        throw new XlsxMergeError(
          `シート「${part.name}」は行のずらし方が分からない部品（${unsafe.join('・')}）を持つため、行の挿入・削除はできません。`,
        );
      }
    }

    const cells: WrittenCell[] = [];
    const next = rewriteSheet({
      xml,
      data,
      rows: plan?.rows ?? null,
      rowMap,
      ctx: oursCtx(part.name),
      theirs: theirsSide,
      onWritten: (c) => cells.push(c),
    });
    if (next !== xml) replaced.set(part.path, next);
    if (plan?.rows != null) written.set(part.name, cells);

    if (!rowMap.identity) {
      for (const rel of part.rels) {
        if (rel.target === null) continue;
        const bytes = ours.read(rel.target);
        if (bytes === null) continue;
        let out: Uint8Array = bytes;
        if (rel.type === 'table') out = rewriteTablePart(bytes, rowMap);
        else if (rel.type === 'drawing') out = rewriteDrawingPart(bytes, rowMap);
        else if (rel.type === 'vmlDrawing') out = rewriteVmlPart(bytes, rowMap);
        else if (rel.type === 'comments' || rel.type === 'threadedComment') out = rewriteCommentsPart(bytes, rowMap);
        if (out !== bytes) replaced.set(rel.target, out);
      }
    }
  }

  // ブック単位の部品
  const wb = ours.read(ours.workbookPath);
  if (wb === null) throw new XlsxMergeError('workbook.xml を読めませんでした。');
  replaced.set(ours.workbookPath, rewriteWorkbookPart(wb, oursCtx(null)));

  const removed = new Set<string>();
  const calcChain = ours.workbookRels.find((r) => r.type === 'calcChain' && r.target !== null);
  if (calcChain?.target != null) {
    removed.add(lower(calcChain.target));
    const rels = ours.read(ours.workbookRelsPath);
    if (rels !== null) replaced.set(ours.workbookRelsPath, removeRelationship(rels, 'calcChain'));
    const types = ours.read('[Content_Types].xml');
    if (types !== null) replaced.set('[Content_Types].xml', removeContentTypeOverride(types, '/' + calcChain.target));
  }

  if (anyChanged) {
    for (const entry of ours.archive.entries.values()) {
      const name = entry.name;
      const isChart = /^xl\/charts\/chart[^/]*\.xml$/i.test(name);
      const isPivotCache = /^xl\/pivotCache\/pivotCacheDefinition[^/]*\.xml$/i.test(name);
      if (!isChart && !isPivotCache) continue;
      const bytes = ours.read(name);
      if (bytes === null) continue;
      const out = isChart
        ? rewriteChartPart(bytes, oursCtx(null))
        : rewritePivotCachePart(bytes, (sheet) => oursMaps.get(lower(sheet)) ?? null);
      if (out !== bytes) replaced.set(name, out);
    }
  }

  const stylesOut = styles.result();
  if (stylesOut !== null) replaced.set(oursStylesPath, stylesOut);

  // ZIP を組む（元の並びのまま）
  const replacedLower = new Map([...replaced].map(([k, v]) => [lower(k), v]));
  const items: ZipWriteItem[] = [];
  for (const entry of ours.archive.entries.values()) {
    const key = lower(entry.name);
    if (removed.has(key)) continue;
    const data = replacedLower.get(key);
    items.push(data === undefined ? { kind: 'copy', entry } : { kind: 'data', name: entry.name, data });
  }
  const zip = writeZip(ours.archive, items, input.deflate);
  if (!zip.ok) throw new XlsxMergeError('ブックを書き出せませんでした（' + zip.reason + '）。');

  verify(zip.bytes, input, written);
  return zip.bytes;
}

/** 解決後の書式の比較の鍵。ユーザー定義の表示形式は番号が付け替わるので、書式の文字列で比べる。 */
function styleKey(table: StyleTable | null, index: number): string {
  const style = table?.cells[index] ?? table?.cells[0] ?? null;
  if (style === null) return 'null';
  return JSON.stringify({ ...style, numFmtId: style.numFmtCode !== null ? -1 : style.numFmtId });
}

/**
 * 書いたブックを開き直し、採ったシートのセルが狙いどおりかを確かめる（docs/07 6 章の 5）。
 * 値・数式・書式（解決後）が、出どころのセルと同じでなければ投げる。
 */
function verify(bytes: Uint8Array, input: XlsxMergeInput, written: ReadonlyMap<string, readonly WrittenCell[]>): void {
  const opened = openWorkbook(bytes, input.inflate, DEFAULT_LIMITS);
  if (!opened.ok) throw new XlsxMergeError('書き出したブックを開き直せませんでした（' + opened.reason + '）。');
  const out = opened.workbook;
  for (const [name, cells] of written) {
    const data = sheetData(out, name);
    if (data === null) throw new XlsxMergeError(`書き出したブックにシート「${name}」がありません。`);
    const expected = new Map<string, WrittenCell>();
    for (const c of cells) expected.set(String(c.row) + ':' + String(c.col), c);
    let seen = 0;
    data.rows.forEach((row, r) => {
      for (const cell of row?.cells ?? []) {
        const want = expected.get(String(r) + ':' + String(cell.col));
        const where = `シート「${name}」の ${cellAddress(r, cell.col)}`;
        if (want === undefined) throw new XlsxMergeError(`照合に失敗しました: ${where} に予定に無いセルがあります。`);
        seen += 1;
        const source: CellData = { ...want.source, formula: want.formula };
        const sst = want.side === 'ours' ? input.oursBook.sst : input.theirsBook.sst;
        if (!cellsEqual(cell, out.sst, source, sst)) {
          throw new XlsxMergeError(`照合に失敗しました: ${where} の値・数式が予定と違います。`);
        }
        const srcStyles = want.side === 'ours' ? input.oursBook.styles : input.theirsBook.styles;
        if (styleKey(out.styles, cell.style) !== styleKey(srcStyles, want.source.style)) {
          throw new XlsxMergeError(`照合に失敗しました: ${where} の書式が予定と違います（テーマの色が両側で違う可能性があります）。`);
        }
      }
    });
    if (seen !== expected.size) throw new XlsxMergeError(`照合に失敗しました: シート「${name}」のセルが足りません。`);
  }
}

