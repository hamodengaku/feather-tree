/*
 * Excel 差分（決定 33）の core のモデル → IPC の DTO。
 *
 * 数値の並びは number[] にして送る（contract.ts の注記）。どれも純関数で、git は起動しない。
 */

import {
  buildRowPage,
  conflictTargetsOf,
  cellDetail,
  excelToken,
  type ExcelComparison,
  type ExcelConflict,
  type ExcelFileList,
  type ExcelSide,
} from '@feathertree/core';
import type { CellStyle, RowDiff, SheetComparison, SheetGeometry, SheetInfo, StyleTable } from '@feathertree/core';
import type {
  ExcelCellDetailDto,
  ExcelCellStyleDto,
  ExcelConflictDto,
  ExcelFileListDto,
  ExcelRowDiffDto,
  ExcelRowPageDto,
  ExcelSheetLayoutDto,
  ExcelSheetSummaryDto,
  ExcelSideDto,
  ExcelViewDto,
} from '@feathertree/ipc';

export function toExcelFileListDto(list: ExcelFileList): ExcelFileListDto {
  return {
    entries: list.entries.map(({ entry, openable }) => ({
      kind: entry.kind,
      path: entry.path,
      ...(entry.origPath === undefined ? {} : { origPath: entry.origPath }),
      staged: entry.staged,
      worktree: entry.worktree,
      ...(entry.score === undefined ? {} : { score: entry.score }),
      openable,
    })),
    truncated: list.truncated,
  };
}

function toSideDto(side: ExcelSide): ExcelSideDto {
  return { state: side.state, bytes: side.bytes, detail: side.detail };
}

function isHidden(sheet: SheetInfo | null): boolean {
  return sheet !== null && sheet.state !== 'visible';
}

function toSheetSummary(sheet: SheetComparison): ExcelSheetSummaryDto {
  const kind = sheet.new?.kind ?? sheet.old?.kind ?? 'other';
  return {
    index: sheet.index,
    oldName: sheet.old?.name ?? null,
    newName: sheet.new?.name ?? null,
    mark: sheet.mark,
    renamed: sheet.renamed,
    kind,
    hidden: isHidden(sheet.old) || isHidden(sheet.new),
    oldProblem: sheet.old?.problem ?? null,
    newProblem: sheet.new?.problem ?? null,
    changedRows: sheet.changedRowCount,
    addedRows: sheet.addedRows,
    removedRows: sheet.removedRows,
    changedCells: sheet.changedCells,
    positional: sheet.positional,
    columnsTruncated: sheet.old?.data?.columnsTruncated === true || sheet.new?.data?.columnsTruncated === true,
  };
}

function toConflictDto(conflict: ExcelConflict | null): ExcelConflictDto | null {
  if (conflict === null) return null;
  return {
    source: conflict.source,
    markers: conflict.markers,
    blocks: conflict.blocks,
    worktree: conflict.worktree,
    cellResolvable: conflict.cellResolvable,
    fingerprint: conflict.fingerprint,
  };
}

/** 未マージでセル単位に採れるとき、シートごとの決めるべき所・採れない所を添える（決定 34）。 */
function withConflictTargets(view: ExcelComparison, sheets: ExcelSheetSummaryDto[]): ExcelSheetSummaryDto[] {
  if (view.conflict === null) return sheets;
  const targets = conflictTargetsOf(view);
  return sheets.map((summary, i) => {
    const t = targets?.[i];
    return { ...summary, conflict: t === undefined ? null : { cells: [...t.cells], rows: [...t.rows], blocked: t.blocked.map((b) => ({ ...b })) } };
  });
}

export function toExcelViewDto(view: ExcelComparison): ExcelViewDto {
  return {
    token: excelToken(view),
    path: view.path,
    headPath: view.headPath,
    old: toSideDto(view.old),
    new: toSideDto(view.new),
    sheets: withConflictTargets(view, view.comparison.sheets.map(toSheetSummary)),
    vbaChanged: view.comparison.vbaChanged,
    conflict: toConflictDto(view.conflict),
  };
}

function toStyleDto(s: CellStyle): ExcelCellStyleDto {
  return {
    bold: s.bold,
    italic: s.italic,
    underline: s.underline,
    strike: s.strike,
    color: s.color,
    sizePt: s.sizePt,
    fill: s.fill,
    borderTop: s.borderTop,
    borderRight: s.borderRight,
    borderBottom: s.borderBottom,
    borderLeft: s.borderLeft,
    horizontal: s.horizontal,
    vertical: s.vertical,
    wrap: s.wrap,
    indent: s.indent,
  };
}

const DEFAULT_FONT_PT = 11;

export function toSheetLayoutDto(
  token: string,
  sheet: number,
  g: SheetGeometry,
  oldStyles: StyleTable | null,
  newStyles: StyleTable | null,
): ExcelSheetLayoutDto {
  return {
    oldStyles: oldStyles?.cells.map(toStyleDto) ?? [],
    newStyles: newStyles?.cells.map(toStyleDto) ?? [],
    oldDefaultFontPt: oldStyles?.defaultSizePt ?? DEFAULT_FONT_PT,
    newDefaultFontPt: newStyles?.defaultSizePt ?? DEFAULT_FONT_PT,
    oldRowStyle: Array.from(g.oldRowStyle),
    newRowStyle: Array.from(g.newRowStyle),
    oldColStyle: Array.from(g.oldColStyle),
    newColStyle: Array.from(g.newColStyle),
    token,
    sheet,
    rowCount: g.rowCount,
    oldRow: Array.from(g.oldRow),
    newRow: Array.from(g.newRow),
    rowState: Array.from(g.rowState),
    rowHeight: Array.from(g.rowHeightPx),
    rowHidden: Array.from(g.rowHidden),
    colCount: g.colCount,
    colWidth: Array.from(g.colWidthPx),
    colHidden: Array.from(g.colHidden),
    oldMerges: Array.from(g.oldMerges),
    newMerges: Array.from(g.newMerges),
    changedRows: Array.from(g.changedRows),
    frozen: g.frozen,
  };
}

/** 1 回に返す行の上限（contract.ts の excelGetRows）。 */
export const EXCEL_ROW_PAGE_LIMIT = 256;

export function toRowPageDto(
  view: ExcelComparison,
  sheet: SheetComparison,
  start: number,
  count: number,
  maxColumns: number,
): ExcelRowPageDto {
  const rows = buildRowPage(view.comparison, sheet, start, count, maxColumns);
  return {
    token: excelToken(view),
    sheet: sheet.index,
    start,
    rows: rows.map((r) => ({
      old:
        r.old === null
          ? null
          : { row: r.old.row, cols: Array.from(r.old.cols), text: r.old.text, kind: Array.from(r.old.kind), style: Array.from(r.old.style) },
      new:
        r.new === null
          ? null
          : { row: r.new.row, cols: Array.from(r.new.cols), text: r.new.text, kind: Array.from(r.new.kind), style: Array.from(r.new.style) },
      changedCols: Array.from(r.changedCols),
    })),
  };
}

export function toCellDetailDto(view: ExcelComparison, sheet: SheetComparison, row: number, col: number): ExcelCellDetailDto {
  const d = cellDetail(view.comparison, sheet, row, col);
  return { row, col, old: d.old, new: d.new, changed: d.changed };
}

export function toRowDiffDto(view: ExcelComparison, diff: RowDiff): ExcelRowDiffDto {
  return {
    token: excelToken(view),
    path: view.path,
    old: toSideDto(view.old),
    new: toSideDto(view.new),
    sheets: diff.sheets.map((s) => ({
      index: s.index,
      oldName: s.oldName,
      newName: s.newName,
      mark: s.mark,
      renamed: s.renamed,
      positional: s.positional,
      hunks: s.hunks.map((h) => ({ columns: h.columns, rows: h.rows })),
    })),
    truncated: diff.truncated,
    vbaChanged: diff.vbaChanged,
  };
}
