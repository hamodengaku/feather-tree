import { describe, expect, it } from 'vitest';
import type { ExcelConflictDto, ExcelResolveRequestDto, ExcelSheetConflictDto, ExcelSheetSummaryDto } from '@feathertree/ipc';
import { AppState } from '../src/lib/appState.svelte.js';
import { TabActivity } from '../src/lib/tabActivity.js';
import {
  blockReasonAt,
  blockedChoices,
  choiceAt,
  blocksInRanges,
  hunkStartOf,
  nextUnresolved,
  rangeOf,
  targetsInRanges,
  toChoicesDto,
  unresolvedCount,
  unresolvedInSheet,
  type ConflictChoiceState,
  type ConflictSide,
} from '../src/lib/excelConflict.js';
import { blockReasonText, conflictSummary, sideLabel } from '../src/lib/excelText.js';
import { buildPreviewRows, hasAnyChoice, previewIndexOf } from '../src/lib/excelPreview.js';
import type { ExcelSheetLayoutDto } from '@feathertree/ipc';
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
    edits: [string, string][];
    hunks: [string, { end: number; order: 'ours-theirs' | 'theirs-ours' }][];
    rowsBoth: [string, 'ours-theirs' | 'theirs-ours'][];
  }>,
): ConflictChoiceState {
  return {
    cells: new Map(partial.cells ?? []),
    rows: new Map<string, ConflictSide | 'ours-theirs' | 'theirs-ours'>([...(partial.rows ?? []), ...(partial.rowsBoth ?? [])]),
    cols: new Map(partial.cols ?? []),
    rest: partial.rest ?? null,
    edits: new Map(partial.edits ?? []),
    hunks: new Map(partial.hunks ?? []),
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

  it('送る形はシート・座標・側（と打った値）だけ', () => {
    const dto = toChoicesDto(
      state({ cells: [['1:1:2', 'theirs']], rows: [['0:3', 'ours']], cols: [['1:0', 'ours']], rest: null, edits: [['0:1:1', '42']] }),
    );
    expect(dto).toEqual({
      cells: [{ sheet: 1, row: 1, col: 2, side: 'theirs' }],
      rows: [{ sheet: 0, row: 3, side: 'ours' }],
      cols: [{ sheet: 1, col: 0, side: 'ours' }],
      rest: null,
      edits: [{ sheet: 0, row: 1, col: 1, value: '42' }],
      hunks: [],
    });
  });

  it('打った値はセルの指定より強く、相手側を採れない所では数える', () => {
    const s = state({ cells: [['0:1:1', 'ours']], edits: [['0:1:1', 'x']] });
    expect(choiceAt(S0, s, 0, 1, 1)).toBe('edit');
    const blocked = summary(0, [1, 1], [], [{ row: 1, col: 1, reason: 'table-header' }]);
    expect(blockedChoices([blocked], state({ edits: [['0:1:1', 'x']] })).count).toBe(1);
  });

  it('範囲に含まれる決めるべき所（片側だけの行は範囲が掛かれば含む）', () => {
    expect(targetsInRanges(S0, [{ r1: 0, c1: 2, r2: 5, c2: 2 }])).toEqual({ cells: [{ row: 1, col: 2 }], rows: [3] });
    expect(targetsInRanges(S0, [rangeOf({ row: 1, col: 0 }, { row: 1, col: 0 })])).toEqual({ cells: [], rows: [] });
  });
});

describe('両方を採用（docs/07 7.2）', () => {
  /** 揃えた行 1・2（セル）と 3（片側だけ）が続いて 1 つのブロック、5 が別のブロック。 */
  const S = summary(0, [1, 1, 2, 0, 5, 0], [3]);

  it('ブロックは決めるべき所のある行が続く区間', () => {
    expect(hunkStartOf(S, 3)).toBe(1);
    expect(hunkStartOf(S, 5)).toBe(5);
    expect(hunkStartOf(S, 4)).toBe(-1);
    // 範囲が掛かる行を、ブロックごとの続いた範囲にまとめる
    expect(blocksInRanges(S, [{ r1: 2, c1: 0, r2: 5, c2: 0 }])).toEqual([
      { start: 2, end: 4 },
      { start: 5, end: 6 },
    ]);
  });

  it('両方採用の範囲は中のどの指定よりも強く、未決定を埋める', () => {
    const s = state({ hunks: [['0:1', { end: 4, order: 'theirs-ours' }]], edits: [['0:1:1', 'x']], cells: [['0:2:0', 'ours']] });
    expect(choiceAt(S, s, 0, 1, 1)).toBe('theirs-ours');
    expect(choiceAt(S, s, 0, 3, 0)).toBe('theirs-ours');
    expect(choiceAt(S, s, 0, 5, 0)).toBeNull();
    expect(unresolvedCount([S], s)).toBe(1);
  });

  it('行の両方採用はセルの指定・打った値より強い', () => {
    const s = state({ rowsBoth: [['0:1', 'ours-theirs']], edits: [['0:1:1', 'x']] });
    expect(choiceAt(S, s, 0, 1, 1)).toBe('ours-theirs');
  });

  it('送る形にブロックの指定が載る', () => {
    expect(toChoicesDto(state({ hunks: [['0:1', { end: 3, order: 'ours-theirs' }]] })).hunks).toEqual([
      { sheet: 0, row: 1, end: 3, order: 'ours-theirs' },
    ]);
  });
});

describe('マージ後のプレビューの行の並び（docs/07 7.3）', () => {
  /**
   * 揃えた行: 0 同じ / 1 値の違う行 / 2 自分側だけ（O）/ 3 相手側だけ（T）/ 4 同じ。
   * 決めるべき所: 行 1 の B 列、行 2・3（片側だけ）。行 1〜3 が 1 つのブロック。
   */
  const layout = {
    rowCount: 5,
    oldRow: [0, 1, 2, -1, 3],
    newRow: [0, 1, -1, 2, 3],
    rowState: [0, 1, 3, 2, 0],
  } as unknown as ExcelSheetLayoutDto;
  const S = summary(0, [1, 1], [2, 3]);
  const pick = (rows: ReturnType<typeof buildPreviewRows>): string[] =>
    rows.map((r) => String(r.aligned) + (r.side === 'ours' ? 'o' : 't') + (r.mixed ? 'm' : '') + (r.undecided ? '?' : ''));

  it('決めていない片側だけの行は印を付けて出し、値の違う行はセルごと（mixed）', () => {
    expect(pick(buildPreviewRows(layout, S, state({}), 0))).toEqual(['0o', '1om', '2o?', '3t?', '4o']);
    expect(hasAnyChoice(state({}))).toBe(false);
  });

  it('片側だけの行は、その行がある側を採れば出し、無い側を採れば出さない', () => {
    expect(pick(buildPreviewRows(layout, S, state({ rest: 'theirs' }), 0))).toEqual(['0o', '1om', '3t', '4o']);
    expect(pick(buildPreviewRows(layout, S, state({ rest: 'ours' }), 0))).toEqual(['0o', '1om', '2o', '4o']);
  });

  it('両方を採用の範囲は、自分側の行を全部 → 相手側の行を全部（または逆）', () => {
    const rows = buildPreviewRows(layout, S, state({ hunks: [['0:2', { end: 4, order: 'theirs-ours' }]] }), 0);
    expect(pick(rows)).toEqual(['0o', '1om', '3t', '2o', '4o']);
    expect(previewIndexOf(rows).get(2)).toBe(3);
    // 行で両方を採用すると、値の違う行が 2 行に分かれる
    expect(pick(buildPreviewRows(layout, S, state({ rowsBoth: [['0:1', 'ours-theirs']], rest: 'ours' }), 0))).toEqual([
      '0o',
      '1o',
      '1t',
      '2o',
      '4o',
    ]);
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
    expect(req.resolution).toEqual({ kind: 'cells', choices: { cells: [], rows: [], cols: [], rest: 'theirs', edits: [], hunks: [] } });
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
    expect([...ex.conflictCells.keys()]).toEqual(['1:1:2']);
    ex.pointerDown('row', 3, 0, { shift: false, ctrl: false });
    ex.chooseSelection('ours');
    expect(ex.conflictRows.get('1:3')).toBe('ours');
    ex.pointerDown('cell', 0, 0, { shift: false, ctrl: false });
    ex.pointerEnter('cell', 4, 2);
    ex.chooseSelection(null);
    expect(ex.conflictCells.size).toBe(0);
    expect(ex.conflictRows.size).toBe(0);
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
    expect(ex.conflictEdits.get('1:1:1')).toBe('99');
    // 側を選び直すと打った値は外れる
    ex.chooseCell('ours');
    expect(ex.conflictEdits.has('1:1:1')).toBe(false);
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
    expect(ex.conflictHunks.get('1:1')).toEqual({ end: 2, order: 'theirs-ours' });
    expect(ex.conflictHunks.get('1:3')).toEqual({ end: 4, order: 'theirs-ours' });
    ex.chooseBothSelection('theirs-ours');
    expect(ex.conflictHunks.size).toBe(0);
    ex.chooseBothSelection('ours-theirs');
    ex.chooseSelection('ours');
    expect(ex.conflictHunks.size).toBe(0);
  });
});
