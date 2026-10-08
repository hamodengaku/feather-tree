import { describe, expect, it } from 'vitest';
import type { ExcelConflictDto, ExcelResolveRequestDto, ExcelSheetConflictDto, ExcelSheetSummaryDto } from '@feathertree/ipc';
import { AppState } from '../src/lib/appState.svelte.js';
import { TabActivity } from '../src/lib/tabActivity.js';
import {
  blockReasonAt,
  blockedChoices,
  choiceAt,
  nextUnresolved,
  toChoicesDto,
  unresolvedCount,
  unresolvedInSheet,
  type ConflictChoiceState,
  type ConflictSide,
} from '../src/lib/excelConflict.js';
import { blockReasonText, conflictSummary, sideLabel } from '../src/lib/excelText.js';
import { FakeBridge, entry, installDocumentStub } from './fakeBridge.js';

installDocumentStub();

/*
 * Excel 差分モードのコンフリクト（決定 34）の renderer の責務。
 *   - 採り方の優先順位（セル > 行 > 列 > 残りすべて。片側だけの行は 行 > 残り）と、シートをまたぐ未決定の数え方
 *   - 相手側を採れない所（docs/07 3.2）に相手側が指定されていることの検出
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

function state(
  partial: Partial<{
    cells: [string, ConflictSide][];
    rows: [string, ConflictSide][];
    cols: [string, ConflictSide][];
    rest: ConflictSide | null;
  }>,
): ConflictChoiceState {
  return {
    cells: new Map(partial.cells ?? []),
    rows: new Map(partial.rows ?? []),
    cols: new Map(partial.cols ?? []),
    rest: partial.rest ?? null,
  };
}

describe('採り方の優先順位と未決定', () => {
  it('セル > 行 > 列 > 残りすべて（シートごと）', () => {
    const s = state({ cells: [['0:1:1', 'ours']], rows: [['0:1', 'theirs']], cols: [['0:2', 'ours']], rest: 'ours' });
    expect(choiceAt(S0, s, 0, 1, 1)).toBe('ours');
    expect(choiceAt(S0, s, 0, 1, 2)).toBe('theirs');
    expect(choiceAt(S0, state({ cols: [['0:2', 'ours']], rest: 'theirs' }), 0, 1, 2)).toBe('ours');
    // 別のシートの指定は効かない
    expect(choiceAt(S0, state({ cols: [['1:2', 'ours']] }), 0, 1, 2)).toBeNull();
  });

  it('片側だけの行には列・セルの指定が効かない（行 > 残りすべて）', () => {
    const s = state({ cells: [['0:3:0', 'ours']], cols: [['0:0', 'ours']] });
    expect(choiceAt(S0, s, 0, 3, 0)).toBeNull();
    expect(choiceAt(S0, state({ rows: [['0:3', 'theirs']] }), 0, 3, 0)).toBe('theirs');
  });

  it('未決定はブック全体で数え、シートごとにも出せる', () => {
    expect(unresolvedCount(SHEETS, state({}))).toBe(4);
    expect(unresolvedCount(SHEETS, state({ cols: [['0:1', 'ours']] }))).toBe(3);
    expect(unresolvedCount(SHEETS, state({ rest: 'theirs' }))).toBe(0);
    expect(unresolvedInSheet(S1, state({}))).toBe(1);
  });

  it('セル単位で採れない（概要に conflict が無い）なら null', () => {
    expect(unresolvedCount([{ ...S0, conflict: null }], state({}))).toBeNull();
  });

  it('次の未決定は今の位置より後ろ → 後のシート → 先頭から', () => {
    const s = state({ cells: [['0:1:2', 'ours']] });
    expect(nextUnresolved(SHEETS, s, null)).toEqual({ sheet: 0, row: 1, col: 1 });
    expect(nextUnresolved(SHEETS, s, { sheet: 0, row: 1, col: 1 })).toEqual({ sheet: 0, row: 3, col: 0 });
    expect(nextUnresolved(SHEETS, s, { sheet: 0, row: 3, col: 0 })).toEqual({ sheet: 1, row: 0, col: 0 });
    expect(nextUnresolved(SHEETS, s, { sheet: 1, row: 5, col: 0 })).toEqual({ sheet: 0, row: 1, col: 1 });
    expect(nextUnresolved(SHEETS, state({ rest: 'ours' }), null)).toBeNull();
  });

  it('相手側を採れない所に相手側が指定されていれば数える', () => {
    const sheet = summary(0, [1, 1], [3], [{ row: 3, col: -1, reason: 'unsafe-part' }]);
    expect(blockReasonAt(sheet, 3, 5)).toBe('unsafe-part');
    expect(blockReasonAt(sheet, 1, 1)).toBeNull();
    expect(blockedChoices([sheet], state({ rest: 'ours' })).count).toBe(0);
    const chosen = blockedChoices([sheet], state({ rest: 'theirs' }));
    expect(chosen.count).toBe(1);
    expect(chosen.first).toEqual({ sheet: 0, row: 3, col: 0, reason: 'unsafe-part' });
    expect(blockReasonText('unsafe-part')).toContain('ファイル単位');
  });

  it('送る形はシート・座標・側だけ', () => {
    const dto = toChoicesDto(state({ cells: [['1:1:2', 'theirs']], rows: [['0:3', 'ours']], cols: [['1:0', 'ours']], rest: null }));
    expect(dto).toEqual({
      cells: [{ sheet: 1, row: 1, col: 2, side: 'theirs' }],
      rows: [{ sheet: 0, row: 3, side: 'ours' }],
      cols: [{ sheet: 1, col: 0, side: 'ours' }],
      rest: null,
    });
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
  bridge.changes = [entry('data/item.xlsx', { kind: 'unmerged', staged: 'U', worktree: 'U' })];
  bridge.excelConflict = conflict;
  const app = new AppState(bridge.build(), { tabActivity: new TabActivity({ delayMs: 0, minMs: 0, graceMs: 0 }) });
  await app.initialize();
  await app.enterExcelMode();
  await app.excel.ensure();
  return { app, bridge };
}

describe('Excel 差分モードの採用（決定 34）', () => {
  it('選んだセル・行・列・残りの採り方をシートごとに持ち、押し直すと外す', async () => {
    const { app } = await boot(MARKERS);
    expect(app.excel.sheet).toBe(1);
    expect(app.excel.selection).toEqual({ row: 1, col: 1 });
    app.excel.chooseCell('theirs');
    expect(app.excel.conflictCells.get('1:1:1')).toBe('theirs');
    app.excel.chooseCell('theirs');
    expect(app.excel.conflictCells.has('1:1:1')).toBe(false);
    app.excel.chooseCol('ours');
    app.excel.chooseRest('theirs');
    expect(app.excel.conflictCols.get('1:1')).toBe('ours');
    expect(app.excel.conflictRest).toBe('theirs');
  });

  it('片側だけの行でセルを選んで決めると、行の指定になる', async () => {
    const { app } = await boot(MARKERS);
    await app.excel.selectCell(3, 2);
    app.excel.chooseCell('ours');
    expect(app.excel.conflictRows.get('1:3')).toBe('ours');
    expect(app.excel.conflictCells.size).toBe(0);
  });

  it('次の未決定へで、決めていない所へ移る', async () => {
    const { app } = await boot(MARKERS);
    app.excel.chooseRow('ours');
    await app.excel.moveToUnresolved();
    expect(app.excel.selection).toEqual({ row: 3, col: 0 });
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

  it('書き込みはシート・座標・側だけを、表示中のトークンと一緒に送る', async () => {
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
