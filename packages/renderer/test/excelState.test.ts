import { describe, expect, it } from 'vitest';
import type { ExcelSheetLayoutDto, ExcelSheetSummaryDto } from '@feathertree/ipc';
import { AppState } from '../src/lib/appState.svelte.js';
import { TabActivity } from '../src/lib/tabActivity.js';
import {
  columnCollapsed,
  columnLabel,
  coveredCells,
  effectiveRowHeights,
  mergeRects,
  mirrorScroll,
  nextChangedRow,
  pagesFor,
  rowCollapsed,
  rowHeaderWidth,
  visibleMerges,
} from '../src/lib/excelGrid.js';
import { EXCEL_OPENABLE_EXTENSIONS, isOpenableExcelPath } from '../src/lib/excelPath.js';
import { sheetLabel, sheetNotice, sideNotice, workbookSummary } from '../src/lib/excelText.js';
import { FakeBridge, entry, installDocumentStub } from './fakeBridge.js';

installDocumentStub();

/*
 * Excel 差分モード（決定 33）の renderer の状態。
 *
 * 見るのは renderer の責務だけ——
 *   - モードに入るまで Excel の IPC を 1 度も呼ばない（差分モードでは行単位比較だけ）
 *   - モードに入るとき viewMode だけを書き、ブランチペインの畳みには触れない
 *   - 古い応答を捨てる（要件 E6）、diff-stale ならビューから取り直す
 *   - 折り畳みボタンの相手が Excel 差分モードでだけ一覧に替わる
 */

async function boot(setup?: (bridge: FakeBridge) => void): Promise<{ app: AppState; bridge: FakeBridge }> {
  const bridge = new FakeBridge();
  bridge.changes = [entry('data/item.xlsx'), entry('src/a.ts')];
  setup?.(bridge);
  const app = new AppState(bridge.build(), {
    tabActivity: new TabActivity({ delayMs: 0, minMs: 0, graceMs: 0 }),
  });
  await app.initialize();
  return { app, bridge };
}

const names = (bridge: FakeBridge): string[] => bridge.calls.map((c) => c.name);

/** 非同期の後始末（ページの取得など）が終わるのを待つ。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('差分モードの Excel（行単位の比較）', () => {
  it('Excel を選ぶと diffGet ではなく excelGetRowDiff を呼ぶ', async () => {
    const { app, bridge } = await boot();
    bridge.calls.length = 0;
    await app.select({ path: 'data/item.xlsx', staged: false });
    expect(names(bridge)).toContain('excelGetRowDiff');
    expect(names(bridge)).not.toContain('diffGet');
    expect(app.excelRowDiff?.path).toBe('data/item.xlsx');
    expect(app.diff).toBeNull();
  });

  it('Excel 以外は従来どおり diffGet で、行単位の比較は消える', async () => {
    const { app, bridge } = await boot();
    await app.select({ path: 'data/item.xlsx', staged: false });
    bridge.calls.length = 0;
    await app.select({ path: 'src/a.ts', staged: false });
    expect(names(bridge)).toContain('diffGet');
    expect(app.excelRowDiff).toBeNull();
  });

  it('同じ Excel を選び直しても取り直さない', async () => {
    const { app, bridge } = await boot();
    await app.select({ path: 'data/item.xlsx', staged: false });
    bridge.calls.length = 0;
    await app.select({ path: 'data/item.xlsx', staged: false });
    expect(names(bridge)).not.toContain('excelGetRowDiff');
  });

  it('差分モードでいる限り Excel 差分モードの IPC は呼ばない', async () => {
    const { bridge } = await boot();
    expect(names(bridge).some((n) => n === 'excelListFiles' || n === 'excelGetView')).toBe(false);
  });
});

describe('Excel 差分モードへ入る', () => {
  it('viewMode だけを書き、ブランチペインの畳みには触れない', async () => {
    const { app, bridge } = await boot();
    bridge.calls.length = 0;
    await app.enterExcelMode();
    const writes = bridge.calls.filter((c) => c.name === 'settingsUpdate');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args[0]).toEqual({ viewMode: 'excel' });
    expect(app.settings?.branchPaneCollapsed).toBe(false);
  });

  it('差分モードで選んでいた Excel を開いた状態で入る', async () => {
    const { app } = await boot();
    await app.select({ path: 'data/item.xlsx', staged: false });
    await app.enterExcelMode();
    expect(app.excel.selectedPath).toBe('data/item.xlsx');
  });

  it('「Excel モードで開く」で指定のファイルを選んで入る', async () => {
    const { app } = await boot();
    await app.openInExcelMode('data/new.xlsx');
    expect(app.viewMode).toBe('excel');
    expect(app.excel.selectedPath).toBe('data/new.xlsx');
  });
});

describe('Excel 差分モードの読み込み', () => {
  it('ensure で一覧 → 最初に開けるファイル → ビュー → 変更のあるシート → 最初の変更を選ぶ', async () => {
    const { app, bridge } = await boot();
    await app.enterExcelMode();
    bridge.calls.length = 0;
    await app.excel.ensure();
    expect(names(bridge).slice(0, 5)).toEqual(['excelListFiles', 'excelGetView', 'excelGetSheet', 'excelGetRows', 'excelGetCell']);
    expect(app.excel.selectedPath).toBe('data/item.xlsx');
    expect(app.excel.sheet).toBe(1);
    // 最初の変更行の、最初に変わった列（偽の橋渡しでは B 列）
    expect(app.excel.selection).toEqual({ row: 1, col: 1 });
    expect(app.excel.scrollRequest?.row).toBe(1);
  });

  it('ensureRows はページ単位で 1 回だけ取りに行く', async () => {
    const { app, bridge } = await boot();
    await app.enterExcelMode();
    await app.excel.ensure();
    // シートを開いた時点で、最初の変更行のページ（0 ページ目）は取ってある
    expect(names(bridge).filter((n) => n === 'excelGetRows')).toHaveLength(1);
    expect(app.excel.rows.get(1)?.new?.text).toEqual(['r1', '10']);
    bridge.calls.length = 0;
    app.excel.ensureRows(0, 5);
    app.excel.ensureRows(0, 5);
    await settle();
    expect(names(bridge)).not.toContain('excelGetRows');
  });

  it('シートを替えると行を捨てて取り直す', async () => {
    const { app, bridge } = await boot();
    await app.enterExcelMode();
    await app.excel.ensure();
    app.excel.ensureRows(0, 5);
    await settle();
    bridge.calls.length = 0;
    await app.excel.selectSheet(0);
    expect(app.excel.sheet).toBe(0);
    expect(app.excel.rows.size).toBe(0);
    expect(names(bridge)).toContain('excelGetSheet');
  });

  it('追い越されたビューの応答は捨てる', async () => {
    const { app, bridge } = await boot();
    await app.enterExcelMode();
    await app.excel.ensure();
    bridge.diffDelayMs = 20;
    const first = app.excel.select('data/new.xlsx');
    bridge.diffDelayMs = 0;
    await app.excel.select('data/item.xlsx');
    await first;
    expect(app.excel.selectedPath).toBe('data/item.xlsx');
    expect(app.excel.view?.path).toBe('data/item.xlsx');
  });

  it('diff-stale ならビューから取り直し、シートは保つ', async () => {
    const { app, bridge } = await boot();
    await app.enterExcelMode();
    await app.excel.ensure();
    bridge.excelStaleOnce = true;
    bridge.calls.length = 0;
    await app.excel.selectCell(2, 1);
    await settle();
    expect(names(bridge)).toContain('excelGetView');
    expect(app.excel.sheet).toBe(1);
    expect(app.excel.error).toBeNull();
  });

  it('次の変更 / 前の変更は変更行を巡回し、スクロールを依頼する', async () => {
    const { app } = await boot();
    await app.enterExcelMode();
    await app.excel.ensure();
    await app.excel.moveToChange(1);
    expect(app.excel.selection?.row).toBe(3);
    await app.excel.moveToChange(1);
    expect(app.excel.selection?.row).toBe(1);
    await app.excel.moveToChange(-1);
    expect(app.excel.selection?.row).toBe(3);
    expect(app.excel.scrollRequest?.row).toBe(3);
  });

  it('ビューの取得に失敗したら案内を出し、履歴にも残す', async () => {
    const { app } = await boot((b) => {
      b.excelViewError = { kind: 'git-failed', message: 'Git LFS の処理に失敗しました' };
    });
    await app.enterExcelMode();
    await app.excel.ensure();
    expect(app.excel.error?.message).toBe('Git LFS の処理に失敗しました');
    expect(app.errorLog[0]?.message).toBe('Git LFS の処理に失敗しました');
  });

  it('更新（reloadActive）で一覧とビューを取り直す', async () => {
    const { app, bridge } = await boot();
    await app.enterExcelMode();
    await app.excel.ensure();
    bridge.calls.length = 0;
    await app.refresh('status');
    expect(names(bridge)).toContain('excelListFiles');
    expect(names(bridge)).toContain('excelGetView');
    expect(names(bridge)).not.toContain('diffGet');
    expect(app.excel.sheet).toBe(1);
  });

  it('他のモードへ移ると重いものを手放し、戻ったら一覧を取り直す', async () => {
    const { app, bridge } = await boot();
    await app.enterExcelMode();
    await app.excel.ensure();
    await app.setViewMode('log');
    expect(app.excel.view).toBeNull();
    expect(app.excel.layout).toBeNull();
    expect(app.excel.selectedPath).toBe('data/item.xlsx');
    bridge.calls.length = 0;
    await app.enterExcelMode();
    await app.excel.ensure();
    expect(names(bridge)).toContain('excelListFiles');
  });

  it('自動で選ぶのは開けるファイルだけ。差分モードで止められた行単位比較は失敗にしない', async () => {
    const { app, bridge } = await boot((b) => {
      b.excelFiles = [{ kind: 'ordinary', path: 'old.xls', staged: '.', worktree: 'M', openable: false }];
    });
    await app.enterExcelMode();
    await app.excel.ensure();
    expect(app.excel.selectedPath).toBeNull();
    expect(names(bridge)).not.toContain('excelGetView');

    await app.setViewMode('diff');
    bridge.excelViewError = { kind: 'cancelled', message: '操作を中断しました。' };
    await app.select({ path: 'data/item.xlsx', staged: false });
    expect(app.diffError).toBeNull();
    expect(app.errorLog).toHaveLength(0);
  });

  it('一覧から消えたファイルを選んでいたら、最初に開けるファイルを選び直す', async () => {
    const { app, bridge } = await boot();
    await app.openInExcelMode('gone.xlsx');
    await app.excel.ensure();
    expect(app.excel.selectedPath).toBe('data/item.xlsx');
    bridge.excelFiles = [];
    await app.excel.loadFiles();
    expect(app.excel.selectedPath).toBeNull();
  });

  it('折り畳みの設定は Excel 一覧とブランチペインで別', async () => {
    const { app } = await boot();
    await app.setExcelFileListCollapsed(true);
    expect(app.settings?.excelFileListCollapsed).toBe(true);
    expect(app.settings?.branchPaneCollapsed).toBe(false);
    await app.setExcelFileListWidth(50);
    expect(app.settings?.excelFileListWidth).toBe(120);
  });
});

describe('グリッドの純関数', () => {
  const layout = (over: Partial<ExcelSheetLayoutDto> = {}): ExcelSheetLayoutDto => ({
    token: 't',
    sheet: 0,
    rowCount: 4,
    oldRow: [0, 1, -1, 2],
    newRow: [0, 1, 2, 3],
    rowState: [0, 0, 2, 1],
    rowHeight: [20, 20, 30, 20],
    rowHidden: [0, 3, 0, 1],
    colCount: 2,
    colWidth: [64, 80],
    colHidden: [3, 1],
    oldMerges: [],
    newMerges: [],
    changedRows: [2, 3],
    frozen: null,
    oldStyles: [],
    newStyles: [],
    oldDefaultFontPt: 11,
    newDefaultFontPt: 11,
    oldRowStyle: [],
    newRowStyle: [],
    oldColStyle: [],
    newColStyle: [],
    ...over,
  });

  it('両側で非表示かつ変更の無い行だけを隠す。変更を含む非表示の行は出す', () => {
    const l = layout();
    expect(rowCollapsed(l, 1, false)).toBe(true);
    expect(rowCollapsed(l, 3, false)).toBe(false);
    expect(rowCollapsed(l, 1, true)).toBe(false);
    expect([...effectiveRowHeights(l, false)]).toEqual([20, 0, 30, 20]);
  });

  it('両側で非表示の列だけを隠す', () => {
    const l = layout();
    expect(columnCollapsed(l, 0, false)).toBe(true);
    expect(columnCollapsed(l, 1, false)).toBe(false);
    expect(columnCollapsed(l, 0, true)).toBe(false);
  });

  it('スクロールの写しは違うときだけ', () => {
    expect(mirrorScroll({ top: 100, left: 5 }, { top: 100, left: 0 })).toEqual({ top: null, left: 5 });
    expect(mirrorScroll({ top: 100.2, left: 0 }, { top: 100, left: 0 })).toEqual({ top: null, left: null });
  });

  it('結合: 見えている範囲と交わるもの・覆われるセル', () => {
    const rects = mergeRects([0, 0, 1, 1, 10, 0, 10, 2]);
    expect(visibleMerges(rects, 0, 5, 0, 5)).toHaveLength(1);
    expect([...coveredCells(rects.slice(0, 1))].sort()).toEqual(['0:1', '1:0', '1:1']);
  });

  it('次の変更は端で折り返す。変更が無ければ null', () => {
    expect(nextChangedRow([2, 5, 9], null, 1)).toBe(2);
    expect(nextChangedRow([2, 5, 9], 5, 1)).toBe(9);
    expect(nextChangedRow([2, 5, 9], 9, 1)).toBe(2);
    expect(nextChangedRow([2, 5, 9], 2, -1)).toBe(9);
    expect(nextChangedRow([], 0, 1)).toBeNull();
  });

  it('列文字・行見出しの幅・ページ', () => {
    expect(columnLabel(0)).toBe('A');
    expect(columnLabel(27)).toBe('AB');
    expect(rowHeaderWidth(layout())).toBe(32);
    expect(pagesFor(0, 10)).toEqual([0]);
    expect(pagesFor(250, 600)).toEqual([0, 1, 2]);
    expect(pagesFor(5, 5)).toEqual([]);
  });
});

describe('対象ファイルと案内の文言', () => {
  it('拡張子の一覧は core と同じ（.xlsx / .xlsm / .xltx / .xltm）。ロックファイルは除く', () => {
    expect([...EXCEL_OPENABLE_EXTENSIONS]).toEqual(['.xlsx', '.xlsm', '.xltx', '.xltm']);
    expect(isOpenableExcelPath('data/Book.XLSX')).toBe(true);
    expect(isOpenableExcelPath('data/~$Book.xlsx')).toBe(false);
    expect(isOpenableExcelPath('data/old.xls')).toBe(false);
  });

  const summary = (over: Partial<ExcelSheetSummaryDto> = {}): ExcelSheetSummaryDto => ({
    index: 0,
    oldName: 'a',
    newName: 'a',
    mark: 'same',
    renamed: false,
    kind: 'worksheet',
    hidden: false,
    oldProblem: null,
    newProblem: null,
    changedRows: 0,
    addedRows: 0,
    removedRows: 0,
    changedCells: 0,
    positional: false,
    columnsTruncated: false,
    ...over,
  });

  it('どの状態でも案内を出す（白い画面にしない）', () => {
    for (const state of ['absent', 'lfs-pointer', 'lfs-failed', 'unavailable', 'encrypted-or-legacy', 'not-spreadsheet', 'not-zip', 'broken', 'too-large', 'locked', 'empty'] as const) {
      expect(sideNotice('old', state)).not.toBeNull();
    }
    expect(sideNotice('old', 'ok')).toBeNull();
    expect(sheetNotice('old', summary({ oldName: null }))).toContain('旧版にありません');
    expect(sheetNotice('new', summary({ kind: 'chartsheet' }))).toContain('グラフ');
    expect(sheetNotice('new', summary())).toBeNull();
  });

  it('シートの名前変更は「旧 → 新」', () => {
    expect(sheetLabel(summary({ oldName: 'x', newName: 'y', renamed: true }))).toBe('x → y');
  });

  it('ブックの一言', () => {
    const ok = { state: 'ok' as const, bytes: 1, detail: null };
    expect(workbookSummary([summary()], ok, ok)).toBe('値の変更はありません');
    expect(workbookSummary([summary({ mark: 'changed' })], ok, ok)).toBe('1 シートに変更');
    expect(workbookSummary([], { ...ok, state: 'absent' }, ok)).toBe('新しく追加したブック');
  });
});
