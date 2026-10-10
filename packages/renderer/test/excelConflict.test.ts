import { describe, expect, it } from 'vitest';
import { blockedChoicesOf, choiceMapsOf, unresolvedCount, type ChoiceMaps, type ConflictChoices } from '@feathertree/conflict-plan';
import type { ExcelConflictDto, ExcelResolveRequestDto, ExcelSheetConflictDto, ExcelSheetSummaryDto } from '@feathertree/ipc';
import { AppState } from '../src/lib/appState.svelte.js';
import { TabActivity } from '../src/lib/tabActivity.js';
import { blocksInRanges, bookRules, rangeOf, rulesFor, targetIndexOf, targetsInRanges } from '../src/lib/excelConflict.js';
import { blockReasonText, sideLabel } from '../src/lib/excelText.js';
import { FakeBridge, entry, installDocumentStub } from './fakeBridge.js';

installDocumentStub();

/*
 * Excel 差分モードのコンフリクト（決定 34）の renderer の責務。
 *   - シートの概要から採り方の規則（@feathertree/conflict-plan。書き込みと同じ）を作ること。規則そのものは
 *     conflict-plan のテストで確かめる
 *   - 選んだ範囲の決めるべき所・両方を採用の単位
 *   - 選択の持ち越し（比較の指紋が同じ間だけ）
 *   - 送るのは座標と側だけ。確認を求められたら確認してから送り直す
 */

const MARKERS: ExcelConflictDto = {
  source: 'markers',
  cellResolvable: true,
  fingerprint: 'f1',
};

function summary(
  index: number,
  cells: number[],
  rows: number[],
  blocked: ExcelSheetConflictDto['blocked'] = [],
): ExcelSheetSummaryDto {
  return {
    index,
    oldName: 'S' + String(index),
    newName: 'S' + String(index),
    mark: 'changed',
    renamed: false,
    kind: 'worksheet',
    hidden: false,
    oldProblem: null,
    newProblem: null,
    changedRows: 1,
    addedRows: 0,
    removedRows: 0,
    changedCells: 1,
    positional: false,
    columnsTruncated: false,
    conflict: { cells, rows, blocked },
  };
}

/** シート 0: 揃えた行 1 の B・C 列が違い、揃えた行 3 が片側だけ。シート 1: 揃えた行 0 の A 列が違う。 */
const S0 = summary(0, [1, 1, 1, 2], [3]);
const S1 = summary(1, [0, 0], []);
const SHEETS: ExcelSheetSummaryDto[] = [S0, S1];

function maps(partial: Partial<ConflictChoices> = {}): ChoiceMaps {
  return choiceMapsOf({ cells: [], rows: [], cols: [], rest: null, ...partial });
}

describe('シートの概要から採り方の規則を作る', () => {
  it('シートごとの規則（別のシートの指定は効かない）', () => {
    const m = maps({ cells: [{ sheet: 0, row: 1, col: 1, side: 'ours' }], cols: [{ sheet: 1, col: 2, side: 'theirs' }] });
    expect(rulesFor(S0, m)?.choiceAt(1, 1)).toBe('ours');
    expect(rulesFor(S0, m)?.choiceAt(1, 2)).toBeNull();
    expect(rulesFor({ ...S0, conflict: null }, m)).toBeNull();
    expect(rulesFor(undefined, m)).toBeNull();
  });

  it('未決定・採れない所はブック全体で数える。セル単位で採れないシートがあれば null', () => {
    expect(unresolvedCount(bookRules(SHEETS, maps()) ?? [])).toBe(4);
    expect(unresolvedCount(bookRules(SHEETS, maps({ rest: 'theirs' })) ?? [])).toBe(0);
    expect(bookRules([{ ...S0, conflict: null }, S1], maps())).toBeNull();
    expect(bookRules([], maps())).toBeNull();
    const blocked = summary(0, [1, 1], [3], [{ row: 3, col: -1, reason: 'unsafe-part' }]);
    const chosen = blockedChoicesOf(bookRules([blocked], maps({ rest: 'theirs' })) ?? []);
    expect(chosen.count).toBe(1);
    expect(chosen.first).toEqual({ sheet: 0, row: 3, col: -1, reason: 'unsafe-part' });
    expect(blockReasonText('unsafe-part')).toContain('ファイル単位');
  });

  it('両方を採用できないシート（main が bothBlocked を載せる）では、範囲そのものを採れない所に数える', () => {
    const unsafe: ExcelSheetSummaryDto = { ...S0, conflict: { cells: [1, 1], rows: [3], blocked: [], bothBlocked: 'unsafe-part' } };
    const rules = bookRules([unsafe], maps({ rest: 'ours', hunks: [{ sheet: 0, row: 3, end: 4, order: 'ours-theirs' }] })) ?? [];
    expect(blockedChoicesOf(rules).count).toBe(1);
  });
});

describe('選んだ範囲', () => {
  it('範囲に含まれる決めるべき所（片側だけの行は範囲が掛かれば含む）', () => {
    const index = targetIndexOf(S0);
    expect(targetsInRanges(index, [{ r1: 0, c1: 2, r2: 5, c2: 2 }])).toEqual({ cells: [{ row: 1, col: 2 }], rows: [3] });
    expect(targetsInRanges(index, [rangeOf({ row: 1, col: 0 }, { row: 1, col: 0 })])).toEqual({ cells: [], rows: [] });
    expect(targetsInRanges(null, [{ r1: 0, c1: 0, r2: 9, c2: 9 }])).toEqual({ cells: [], rows: [] });
  });

  it('範囲が掛かる行を、ブロックごとの続いた範囲にまとめる（両方を採用の単位）', () => {
    // 揃えた行 1・2（セル）と 3（片側だけ）が続いて 1 つのブロック、5 が別のブロック
    const S = summary(0, [1, 1, 2, 0, 5, 0], [3]);
    expect(blocksInRanges(targetIndexOf(S), [{ r1: 2, c1: 0, r2: 5, c2: 0 }])).toEqual([
      { start: 2, end: 4 },
      { start: 5, end: 6 },
    ]);
  });
});

describe('案内の文言', () => {
  it('未マージでは左右の見出しが自分側・相手側になる', () => {
    expect(sideLabel('old', true)).toContain('自分側');
    expect(sideLabel('new', true)).toContain('相手側');
    expect(sideLabel('old')).toBe('旧版（HEAD）');
  });
});

async function boot(conflict: ExcelConflictDto): Promise<{ app: AppState; bridge: FakeBridge }> {
  const bridge = new FakeBridge();
  bridge.changes = [entry('data/item.xlsx', { kind: 'unmerged', staged: 'U', worktree: 'U' })];
  bridge.excelConflict = conflict;
  const app = new AppState(bridge.build(), { tabActivity: new TabActivity({ delayMs: 0, minMs: 0, graceMs: 0 }) });
  await app.initialize();
  await app.enterExcelMode();
  await app.excel.ensure();
  return { app, bridge };
}

describe('Excel 差分モードの採用（決定 34）', () => {
  it('片側だけの行でセルを選んで決めると、行の指定になる', async () => {
    const { app } = await boot(MARKERS);
    expect(app.excel.sheet).toBe(1);
    app.excel.pointerDown('cell', 3, 2, { shift: false, ctrl: false });
    app.excel.chooseSelection('ours');
    expect(app.excel.choices.rows.get('1:3')).toBe('ours');
    expect(app.excel.choices.cells.size).toBe(0);
  });

  it('更新で比較の指紋が同じなら決めたものを持ち越し、変われば捨てる', async () => {
    const { app, bridge } = await boot(MARKERS);
    app.excel.choices.rest = 'ours';
    await app.excel.reload();
    expect(app.excel.choices.rest).toBe('ours');
    bridge.excelConflict = { ...MARKERS, fingerprint: 'f2' };
    await app.excel.reload();
    expect(app.excel.choices.rest).toBeNull();
  });

  it('ブック（段の方式）でも読み直しでは持ち越し、別のファイルに替えたら捨てる', async () => {
    const stages: ExcelConflictDto = { ...MARKERS, source: 'stages' };
    const { app } = await boot(stages);
    app.excel.choices.rest = 'theirs';
    await app.excel.reload();
    expect(app.excel.choices.rest).toBe('theirs');
    await app.excel.loadView('data/other.xlsx');
    expect(app.excel.view?.path).toBe('data/other.xlsx');
    expect(app.excel.choices.rest).toBeNull();
  });

  it('書き込みはシート・座標・側だけを、表示中のトークンと一緒に送る', async () => {
    const { app, bridge } = await boot(MARKERS);
    app.excel.choices.rest = 'theirs';
    const token = app.excel.view?.token;
    const path = app.excel.view?.path;
    await app.resolveExcelConflict({ kind: 'cells', choices: app.excel.choices.toDto() });
    const call = bridge.calls.find((c) => c.name === 'excelResolveConflict');
    const req = call?.args[1] as ExcelResolveRequestDto;
    expect(req.path).toBe(path);
    expect(req.token).toBe(token);
    expect(req.resolution).toEqual({ kind: 'cells', choices: { cells: [], rows: [], cols: [], rest: 'theirs', edits: [], hunks: [] } });
  });

  it('確認を求められたら確認ダイアログを出し、承認すると confirmed で送り直す', async () => {
    const stages: ExcelConflictDto = { ...MARKERS, source: 'stages', cellResolvable: false };
    const { app, bridge } = await boot(stages);
    bridge.requireConfirmation = 'excelResolveConflict';
    await app.resolveExcelConflict({ kind: 'file', side: 'theirs' });
    expect(app.pendingConfirmation?.confirmation.action).toBe('overwrite-conflict-worktree');
    await app.acceptConfirmation();
    const calls = bridge.calls.filter((c) => c.name === 'excelResolveConflict');
    expect(calls.map((c) => c.args[2])).toEqual([undefined, true]);
  });

  it('ドラッグ・Shift・Ctrl で範囲を選び、行番号・列番号で行・列全体を選ぶ', async () => {
    const { app } = await boot(MARKERS);
    const ex = app.excel;
    ex.pointerDown('cell', 1, 0, { shift: false, ctrl: false });
    ex.pointerEnter('cell', 3, 2);
    ex.pointerUp();
    expect(ex.ranges).toEqual([{ r1: 1, c1: 0, r2: 3, c2: 2 }]);
    // Shift: 起点（1,0）から広げ直す
    ex.pointerDown('cell', 4, 1, { shift: true, ctrl: false });
    expect(ex.ranges).toEqual([{ r1: 1, c1: 0, r2: 4, c2: 1 }]);
    expect(ex.selection).toEqual({ row: 1, col: 0 });
    // Ctrl: 足す
    ex.pointerDown('cell', 0, 2, { shift: false, ctrl: true });
    expect(ex.ranges).toHaveLength(2);
    // 行番号・列番号
    ex.pointerDown('row', 2, 0, { shift: false, ctrl: false });
    expect(ex.ranges).toEqual([{ r1: 2, c1: 0, r2: 2, c2: 2 }]);
    ex.pointerDown('col', 0, 1, { shift: false, ctrl: false });
    ex.pointerEnter('cell', 3, 2);
    expect(ex.ranges).toEqual([{ r1: 0, c1: 1, r2: 4, c2: 2 }]);
  });

  it('範囲の決めるべき所へ、まとめて ours / theirs を当て、個別の指定を外せる', async () => {
    const { app } = await boot(MARKERS);
    const ex = app.excel;
    ex.pointerDown('col', 0, 2, { shift: false, ctrl: false });
    ex.chooseSelection('theirs');
    expect([...ex.choices.cells.keys()]).toEqual(['1:1:2']);
    ex.pointerDown('row', 3, 0, { shift: false, ctrl: false });
    ex.chooseSelection('ours');
    expect(ex.choices.rows.get('1:3')).toBe('ours');
    ex.pointerDown('cell', 0, 0, { shift: false, ctrl: false });
    ex.pointerEnter('cell', 4, 2);
    ex.chooseSelection(null);
    expect(ex.choices.cells.size).toBe(0);
    expect(ex.choices.rows.size).toBe(0);
  });

  it('1 セルだけ選んでいれば編集でき、打った値が採り方になる', async () => {
    const { app } = await boot(MARKERS);
    const ex = app.excel;
    ex.pointerDown('cell', 1, 1, { shift: false, ctrl: false });
    expect(ex.editableCell).toEqual({ row: 1, col: 1 });
    ex.startEdit('new', '9');
    expect(ex.editing?.value).toBe('9');
    ex.commitEdit('99');
    expect(ex.editing).toBeNull();
    expect(ex.choices.edits.get('1:1:1')).toBe('99');
    // 側を選び直すと打った値は外れる
    ex.chooseSelection('ours');
    expect(ex.choices.edits.has('1:1:1')).toBe(false);
    // 範囲が 2 セル以上・決めるべき所でないセルは編集できない
    ex.pointerDown('cell', 1, 1, { shift: false, ctrl: false });
    ex.pointerEnter('cell', 1, 2);
    expect(ex.editableCell).toBeNull();
    ex.pointerDown('cell', 0, 0, { shift: false, ctrl: false });
    expect(ex.editableCell).toBeNull();
  });

  it('選んだ行で両方を採用でき、押し直すと外れ、片側を採り直しても外れる', async () => {
    const { app } = await boot(MARKERS);
    const ex = app.excel;
    // 偽の橋渡し: 揃えた行 1（B・C 列）と 3（片側だけ）は別のブロック（2 は違いが無い）
    ex.pointerDown('row', 1, 0, { shift: false, ctrl: false });
    ex.pointerEnter('row', 3, 0);
    expect(ex.selectionBlocks).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
    ex.chooseBothSelection('theirs-ours');
    expect(ex.choices.hunks.get('1:1')).toEqual({ end: 2, order: 'theirs-ours' });
    expect(ex.choices.hunks.get('1:3')).toEqual({ end: 4, order: 'theirs-ours' });
    ex.chooseBothSelection('theirs-ours');
    expect(ex.choices.hunks.size).toBe(0);
    ex.chooseBothSelection('ours-theirs');
    ex.chooseSelection('ours');
    expect(ex.choices.hunks.size).toBe(0);
  });

  it('マージをキャンセルするは確認ダイアログを経て送り直す', async () => {
    const { app, bridge } = await boot(MARKERS);
    bridge.requireConfirmation = 'mergeAbort';
    await app.abortMerge();
    expect(app.pendingConfirmation?.confirmation.action).toBe('abort-merge');
    await app.acceptConfirmation();
    expect(bridge.calls.filter((c) => c.name === 'mergeAbort').map((c) => c.args[1])).toEqual([undefined, true]);
  });

  it('プレビューのセルは、値の違わないセルでも編集でき、両方を採用を外さない', async () => {
    const { app } = await boot(MARKERS);
    const ex = app.excel;
    ex.pointerDown('row', 1, 0, { shift: false, ctrl: false });
    ex.chooseBothSelection('ours-theirs');
    await ex.startPreviewEdit(0, 0, 0, 'old');
    expect(ex.editing).toMatchObject({ row: 0, col: 0, side: 'preview', previewIndex: 0, value: '1' });
    ex.commitEdit('見出し');
    expect(ex.choices.edits.get('1:0:0')).toBe('見出し');
    expect(ex.choices.hunks.size).toBe(1);
  });
});
