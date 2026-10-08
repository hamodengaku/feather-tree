import { describe, expect, it } from 'vitest';
import type { ExcelConflictDto, ExcelResolveRequestDto, ExcelSheetLayoutDto } from '@feathertree/ipc';
import { AppState } from '../src/lib/appState.svelte.js';
import { TabActivity } from '../src/lib/tabActivity.js';
import {
  choiceAt,
  nextUnresolved,
  toChoicesDto,
  unresolvedCount,
  type ConflictChoiceState,
  type ConflictSide,
} from '../src/lib/excelConflict.js';
import { conflictSummary, sideLabel } from '../src/lib/excelText.js';
import { FakeBridge, entry, installDocumentStub } from './fakeBridge.js';

installDocumentStub();

/*
 * Excel 差分モードのコンフリクト（決定 34）の renderer の責務。
 *   - 採り方の優先順位（セル > 行 > 列 > 残りすべて。片側だけの行は 行 > 残り）と未決定の数え方
 *   - 選択の持ち越し（作業ツリーの指紋が同じ間だけ）
 *   - 送るのは座標と側だけ。確認を求められたら確認してから送り直す
 */

const MARKERS: ExcelConflictDto = {
  source: 'markers',
  markers: 'split',
  blocks: 1,
  worktree: 'neither',
  hasBase: false,
  cellResolvable: true,
  fingerprint: 'f1',
};

/** 揃えた行 0..4。1 行目が両側にあって B・C 列が違う、3 行目が相手側だけ。 */
function layout(): ExcelSheetLayoutDto {
  return {
    token: 't',
    sheet: 0,
    rowCount: 5,
    oldRow: [0, 1, 2, -1, 3],
    newRow: [0, 1, 2, 3, 4],
    rowState: [0, 1, 0, 2, 0],
    rowHeight: [20, 20, 20, 20, 20],
    rowHidden: [0, 0, 0, 0, 0],
    colCount: 3,
    colWidth: [64, 64, 64],
    colHidden: [0, 0, 0],
    oldMerges: [],
    newMerges: [],
    changedRows: [1, 3],
    frozen: null,
    oldStyles: [],
    newStyles: [],
    oldDefaultFontPt: 11,
    newDefaultFontPt: 11,
    oldRowStyle: [],
    newRowStyle: [],
    oldColStyle: [],
    newColStyle: [],
    conflictCells: [1, 1, 1, 2],
  };
}

function state(partial: Partial<{
  cells: [string, ConflictSide][];
  rows: [number, ConflictSide][];
  cols: [number, ConflictSide][];
  rest: ConflictSide | null;
}>): ConflictChoiceState {
  return {
    cells: new Map(partial.cells ?? []),
    rows: new Map(partial.rows ?? []),
    cols: new Map(partial.cols ?? []),
    rest: partial.rest ?? null,
  };
}

describe('採り方の優先順位と未決定', () => {
  it('セル > 行 > 列 > 残りすべて', () => {
    const s = state({ cells: [['1:1', 'ours']], rows: [[1, 'theirs']], cols: [[2, 'ours']], rest: 'ours' });
    expect(choiceAt(layout(), s, 1, 1)).toBe('ours');
    expect(choiceAt(layout(), s, 1, 2)).toBe('theirs');
    expect(choiceAt(layout(), state({ cols: [[2, 'ours']], rest: 'theirs' }), 1, 2)).toBe('ours');
    expect(choiceAt(layout(), state({ rest: 'theirs' }), 1, 2)).toBe('theirs');
  });

  it('片側だけの行には列・セルの指定が効かない（行 > 残りすべて）', () => {
    const s = state({ cells: [['3:0', 'ours']], cols: [[0, 'ours']] });
    expect(choiceAt(layout(), s, 3, 0)).toBeNull();
    expect(choiceAt(layout(), state({ rows: [[3, 'theirs']] }), 3, 0)).toBe('theirs');
  });

  it('未決定は衝突セルと片側だけの行の数。全部決まれば 0', () => {
    expect(unresolvedCount(layout(), state({}))).toBe(3);
    expect(unresolvedCount(layout(), state({ cols: [[1, 'ours']] }))).toBe(2);
    expect(unresolvedCount(layout(), state({ rest: 'theirs' }))).toBe(0);
  });

  it('セル単位で採れない（conflictCells が無い）なら null', () => {
    expect(unresolvedCount({ ...layout(), conflictCells: null }, state({}))).toBeNull();
  });

  it('次の未決定は今の位置より後ろ、無ければ先頭から', () => {
    const s = state({ cells: [['1:2', 'ours']] });
    expect(nextUnresolved(layout(), s, null)).toEqual({ row: 1, col: 1 });
    expect(nextUnresolved(layout(), s, { row: 1, col: 1 })).toEqual({ row: 3, col: 0 });
    expect(nextUnresolved(layout(), s, { row: 4, col: 0 })).toEqual({ row: 1, col: 1 });
    expect(nextUnresolved(layout(), state({ rest: 'ours' }), null)).toBeNull();
  });

  it('送る形は座標と側だけ', () => {
    const dto = toChoicesDto(state({ cells: [['1:2', 'theirs']], rows: [[3, 'ours']], rest: null }));
    expect(dto).toEqual({ cells: [{ row: 1, col: 2, side: 'theirs' }], rows: [{ row: 3, side: 'ours' }], cols: [], rest: null });
  });
});

describe('案内の文言', () => {
  it('未マージでは左右の見出しが自分側・相手側になる', () => {
    expect(sideLabel('old', true)).toContain('自分側');
    expect(sideLabel('new', true)).toContain('相手側');
    expect(sideLabel('old')).toBe('旧版（HEAD）');
  });

  it('段の方式では作業ツリーがどちらと同じかを添える', () => {
    const stages: ExcelConflictDto = { ...MARKERS, source: 'stages', markers: 'not-csv', worktree: 'ours', cellResolvable: false };
    expect(conflictSummary(stages)).toContain('作業ツリーは自分側と同じ内容です');
    expect(conflictSummary(MARKERS)).toContain('衝突した所だけ');
  });
});

async function boot(conflict: ExcelConflictDto): Promise<{ app: AppState; bridge: FakeBridge }> {
  const bridge = new FakeBridge();
  bridge.changes = [entry('data/item.csv', { kind: 'unmerged', staged: 'U', worktree: 'U' })];
  bridge.excelConflict = conflict;
  const app = new AppState(bridge.build(), { tabActivity: new TabActivity({ delayMs: 0, minMs: 0, graceMs: 0 }) });
  await app.initialize();
  await app.enterExcelMode();
  await app.excel.ensure();
  return { app, bridge };
}

describe('Excel 差分モードの採用（決定 34）', () => {
  it('選んだセル・行・列・残りの採り方を持ち、押し直すと外す', async () => {
    const { app } = await boot(MARKERS);
    expect(app.excel.selection).toEqual({ row: 1, col: 1 });
    app.excel.chooseCell('theirs');
    expect(app.excel.conflictCells.get('1:1')).toBe('theirs');
    app.excel.chooseCell('theirs');
    expect(app.excel.conflictCells.has('1:1')).toBe(false);
    app.excel.chooseCol('ours');
    app.excel.chooseRest('theirs');
    expect(app.excel.conflictCols.get(1)).toBe('ours');
    expect(app.excel.conflictRest).toBe('theirs');
  });

  it('片側だけの行でセルを選んで決めると、行の指定になる', async () => {
    const { app } = await boot(MARKERS);
    await app.excel.selectCell(3, 2);
    app.excel.chooseCell('ours');
    expect(app.excel.conflictRows.get(3)).toBe('ours');
    expect(app.excel.conflictCells.size).toBe(0);
  });

  it('更新で作業ツリーの指紋が同じなら決めたものを持ち越し、変われば捨てる', async () => {
    const { app, bridge } = await boot(MARKERS);
    app.excel.chooseRest('ours');
    await app.excel.reload();
    expect(app.excel.conflictRest).toBe('ours');
    bridge.excelConflict = { ...MARKERS, fingerprint: 'f2' };
    await app.excel.reload();
    expect(app.excel.conflictRest).toBeNull();
  });

  it('書き込みは座標と側だけを、表示中のトークンと一緒に送る', async () => {
    const { app, bridge } = await boot(MARKERS);
    app.excel.chooseRest('theirs');
    const token = app.excel.view?.token;
    const path = app.excel.view?.path;
    await app.resolveExcelConflict({ kind: 'cells', choices: toChoicesDto(app.excel.choices) });
    const call = bridge.calls.find((c) => c.name === 'excelResolveConflict');
    const req = call?.args[1] as ExcelResolveRequestDto;
    expect(req.path).toBe(path);
    expect(req.token).toBe(token);
    expect(req.resolution).toEqual({ kind: 'cells', choices: { cells: [], rows: [], cols: [], rest: 'theirs' } });
  });

  it('確認を求められたら確認ダイアログを出し、承認すると confirmed で送り直す', async () => {
    const stages: ExcelConflictDto = { ...MARKERS, source: 'stages', markers: 'not-csv', worktree: 'neither', cellResolvable: false };
    const { app, bridge } = await boot(stages);
    bridge.requireConfirmation = 'excelResolveConflict';
    await app.resolveExcelConflict({ kind: 'file', side: 'theirs' });
    expect(app.pendingConfirmation?.confirmation.action).toBe('overwrite-conflict-worktree');
    await app.acceptConfirmation();
    const calls = bridge.calls.filter((c) => c.name === 'excelResolveConflict');
    expect(calls.map((c) => c.args[2])).toEqual([undefined, true]);
  });
});
