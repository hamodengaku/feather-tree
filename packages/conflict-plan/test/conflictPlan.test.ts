import { describe, expect, it } from 'vitest';
import {
  SheetRules,
  TargetIndex,
  blockedChoicesOf,
  cellKey,
  choiceMapsOf,
  hasAnyChoice,
  lineKey,
  planIndexOf,
  planSheet,
  toConflictChoices,
  unresolvedCount,
  type ChoiceMaps,
  type ConflictChoices,
  type ConflictTargets,
  type PlanRow,
} from '../src/index.js';

/*
 * Excel のコンフリクトの採り方の規則（決定 34・docs/07 7.1〜7.3）。
 *
 * 揃えた行: 0 同じ / 1 値の違う行（B・C 列）/ 2 自分側だけ（O）/ 3 相手側だけ（T）/ 4 同じ / 5 値の違う行（A 列）。
 * 行 1〜3 が 1 つのブロック、行 5 が別のブロック。
 */
const ALIGNED = { oldRow: [0, 1, 2, -1, 3, 4], newRow: [0, 1, -1, 2, 3, 4] };
const TARGETS: ConflictTargets = { cells: [1, 1, 1, 2, 5, 0], rows: [2, 3], blocked: [] };

function maps(partial: Partial<ConflictChoices> = {}): ChoiceMaps {
  return choiceMapsOf({ cells: [], rows: [], cols: [], rest: null, ...partial });
}

const rules = (choices: Partial<ConflictChoices> = {}, targets: ConflictTargets = TARGETS): SheetRules =>
  new SheetRules(0, targets, maps(choices));

/** 並びを短い文字にする: 揃えた行 + o/t + 種類の頭文字（same は無し）+ 決まっていない列・相手側の列。 */
function show(rows: readonly PlanRow[]): string[] {
  return rows.map((r) => {
    let s = String(r.aligned) + (r.side === 'ours' ? 'o' : 't');
    if (r.kind !== 'same') s += r.kind[0];
    if (r.theirsCols.size > 0) s += `T${[...r.theirsCols].join('')}`;
    if (r.undecidedCols.size > 0) s += `?${[...r.undecidedCols].join('')}`;
    return s;
  });
}

describe('決めるべき所の引き（TargetIndex）', () => {
  const index = TargetIndex.of(TARGETS);

  it('ブロックは決めるべき所のある行が続く区間', () => {
    expect(index.rows).toEqual([1, 2, 3, 5]);
    expect([0, 1, 2, 3, 4, 5].map((r) => index.hunkStart(r))).toEqual([-1, 1, 1, 1, -1, 5]);
    expect(index.hunkEnd(1)).toBe(4);
    expect(index.hunkEnd(5)).toBe(6);
  });

  it('片側だけの行はどの列でも決めるべき所。両側にある行は値の違う列だけ', () => {
    expect(index.isTarget(2, 7)).toBe(true);
    expect(index.isTarget(1, 2)).toBe(true);
    expect(index.isTarget(1, 0)).toBe(false);
    expect(index.changedCols(1)).toEqual([1, 2]);
    expect(index.changedCols(0)).toEqual([]);
  });

  it('決めるべき所を行・列の順に列挙する（片側だけの行は列 -1）', () => {
    expect([...index.targets()]).toEqual([
      { row: 1, col: 1 },
      { row: 1, col: 2 },
      { row: 2, col: -1 },
      { row: 3, col: -1 },
      { row: 5, col: 0 },
    ]);
  });

  it('同じ概要からは同じ引きを返す', () => {
    expect(TargetIndex.of(TARGETS)).toBe(index);
  });

  it('採れない理由は、片側だけの行なら列を問わず行全体のもの', () => {
    const t = TargetIndex.of({ ...TARGETS, blocked: [{ row: 2, col: -1, reason: 'unsafe-part' }, { row: 1, col: 2, reason: 'table-header' }] });
    expect(t.blockReasonAt(2, 5)).toBe('unsafe-part');
    expect(t.blockReasonAt(1, 2)).toBe('table-header');
    expect(t.blockReasonAt(1, 1)).toBeNull();
  });
});

describe('採り方の優先順位', () => {
  it('セル > 行 > 列 > 残りすべて。打った値はセルより強い', () => {
    const r = rules({
      cells: [{ sheet: 0, row: 1, col: 1, side: 'theirs' }],
      rows: [{ sheet: 0, row: 1, side: 'ours' }],
      cols: [{ sheet: 0, col: 0, side: 'theirs' }],
      rest: 'ours',
      edits: [{ sheet: 0, row: 1, col: 2, value: 'x' }],
    });
    expect(r.cellChoice(1, 1)).toBe('theirs');
    expect(r.cellChoice(1, 2)).toBe('edit');
    expect(r.cellChoice(5, 0)).toBe('theirs');
    expect(r.cellChoice(5, 3)).toBe('ours');
  });

  it('片側だけの行には列・セルの指定が効かない（行 > 残りすべて）', () => {
    const r = rules({ cells: [{ sheet: 0, row: 2, col: 0, side: 'theirs' }], cols: [{ sheet: 0, col: 0, side: 'theirs' }] });
    expect(r.choiceAt(2, 0)).toBeNull();
    expect(rules({ rows: [{ sheet: 0, row: 2, side: 'theirs' }] }).choiceAt(2, 0)).toBe('theirs');
  });

  it('別のシートの指定は効かない', () => {
    const r = new SheetRules(1, TARGETS, maps({ cells: [{ sheet: 0, row: 1, col: 1, side: 'ours' }], edits: [{ sheet: 0, row: 1, col: 2, value: 'x' }] }));
    expect(r.cellChoice(1, 1)).toBeNull();
    expect(r.editsInRow(1).size).toBe(0);
  });
});

describe('両方を採用の範囲（docs/07 7.2）', () => {
  it('範囲の中のどの指定よりも強い', () => {
    const r = rules({
      hunks: [{ sheet: 0, row: 1, end: 3, order: 'theirs-ours' }],
      edits: [{ sheet: 0, row: 1, col: 1, value: 'x' }],
      cells: [{ sheet: 0, row: 1, col: 2, side: 'ours' }],
    });
    expect(r.cellChoice(1, 1)).toBe('theirs-ours');
    expect(r.cellChoice(1, 2)).toBe('theirs-ours');
    expect(r.rowChoice(2)).toBe('theirs-ours');
    expect(r.rowChoice(3)).toBeNull();
  });

  it('ブロックの中に切り詰め、先頭が決めるべき所でなければ無視する', () => {
    expect(rules({ hunks: [{ sheet: 0, row: 2, end: 6, order: 'ours-theirs' }] }).blockAt(2)).toEqual({ start: 2, end: 4, order: 'ours-theirs' });
    const r = rules({ hunks: [{ sheet: 0, row: 0, end: 6, order: 'ours-theirs' }] });
    expect(r.blockAt(1)).toBeNull();
    expect(r.bothRanges()).toEqual([]);
  });

  it('先の範囲に重なる範囲は無視する', () => {
    const r = rules({
      hunks: [
        { sheet: 0, row: 1, end: 3, order: 'ours-theirs' },
        { sheet: 0, row: 2, end: 4, order: 'theirs-ours' },
      ],
    });
    expect(r.bothRanges()).toEqual([{ start: 1, end: 3, order: 'ours-theirs' }]);
    expect(r.rowChoice(3)).toBeNull();
  });
});

describe('未決定と採れない所', () => {
  it('未決定は決めるべき所ごとに数え、両方を採用の範囲は埋める', () => {
    expect(rules().unresolved()).toBe(5);
    expect(rules({ cols: [{ sheet: 0, col: 1, side: 'ours' }] }).unresolved()).toBe(4);
    expect(rules({ hunks: [{ sheet: 0, row: 1, end: 4, order: 'ours-theirs' }] }).unresolved()).toBe(1);
    expect(unresolvedCount([rules({ rest: 'theirs' }), rules()])).toBe(5);
  });

  it('採れない所に相手側・打った値・両方を採用が指定されていれば数える（自分側なら数えない）', () => {
    const blocked: ConflictTargets = {
      ...TARGETS,
      blocked: [{ row: 1, col: 2, reason: 'table-header' }, { row: 2, col: -1, reason: 'unsafe-part' }],
    };
    expect(rules({ rest: 'ours' }, blocked).blockedChoices()).toEqual([]);
    expect(rules({ rest: 'theirs' }, blocked).blockedChoices().map((b) => b.reason)).toEqual(['table-header', 'unsafe-part']);
    expect(rules({ edits: [{ sheet: 0, row: 1, col: 2, value: '1' }] }, blocked).blockedChoices()).toHaveLength(1);
    expect(rules({ hunks: [{ sheet: 0, row: 2, end: 3, order: 'ours-theirs' }] }, blocked).blockedChoices()).toHaveLength(1);
  });

  it('両方を採用できないシートでは、範囲そのものを数える', () => {
    const unsafe: ConflictTargets = { ...TARGETS, bothBlocked: 'unsafe-part' };
    const r = rules({ hunks: [{ sheet: 0, row: 5, end: 6, order: 'ours-theirs' }] }, unsafe);
    expect(r.blockedChoices()).toEqual([{ row: 5, col: -1, reason: 'unsafe-part' }]);
    expect(rules({ rest: 'theirs' }, unsafe).blockedChoices()).toEqual([]);
    const book = blockedChoicesOf([rules(), r]);
    expect(book.count).toBe(1);
    expect(book.first).toEqual({ sheet: 0, row: 5, col: -1, reason: 'unsafe-part' });
  });
});

describe('書き込み後の行の並び（planSheet）', () => {
  it('決めていない所は印を付けて並べ、数える', () => {
    const plan = planSheet(rules(), ALIGNED);
    expect(show(plan.rows)).toEqual(['0o', '1oc?12', '2ou', '3tu', '4o', '5oc?0']);
    expect(plan.unresolved).toBe(5);
    expect(plan.unresolved).toBe(rules().unresolved());
    expect(plan.touched).toBe(false);
  });

  it('片側だけの行は、その行がある側を採れば出し、無い側を採れば出さない', () => {
    expect(show(planSheet(rules({ rest: 'theirs' }), ALIGNED).rows)).toEqual(['0o', '1ocT12', '3tl', '4o', '5ocT0']);
    const ours = planSheet(rules({ rest: 'ours' }), ALIGNED);
    expect(show(ours.rows)).toEqual(['0o', '1oc', '2ol', '4o', '5oc']);
    expect(ours.touched).toBe(false);
  });

  it('値の違う列が全部相手側なら wholeTheirs', () => {
    const plan = planSheet(rules({ rest: 'theirs', cells: [{ sheet: 0, row: 1, col: 1, side: 'ours' }] }), ALIGNED);
    const byRow = new Map(plan.rows.map((r) => [r.aligned, r]));
    expect(byRow.get(1)?.wholeTheirs).toBe(false);
    expect(byRow.get(5)?.wholeTheirs).toBe(true);
    expect(byRow.get(1)?.theirsRow).toBe(1);
  });

  it('両方を採用の範囲は、自分側の行を全部 → 相手側の行を全部（または逆）', () => {
    const plan = planSheet(rules({ rest: 'ours', hunks: [{ sheet: 0, row: 1, end: 4, order: 'theirs-ours' }] }), ALIGNED);
    expect(show(plan.rows)).toEqual(['0o', '1tb', '3tb', '1ob', '2ob', '4o', '5oc']);
    expect(planIndexOf(plan.rows).get(1)).toBe(1);
    expect(planIndexOf(plan.rows).get(2)).toBe(4);
    expect(plan.touched).toBe(true);
  });

  it('打った値は自分側の版（無ければ相手側の版）にだけ当て、違いの無い行・列にも当てる', () => {
    const plan = planSheet(
      rules({
        rest: 'ours',
        hunks: [{ sheet: 0, row: 1, end: 4, order: 'ours-theirs' }],
        edits: [
          { sheet: 0, row: 1, col: 0, value: 'a' },
          { sheet: 0, row: 3, col: 0, value: 'b' },
          { sheet: 0, row: 4, col: 0, value: 'c' },
          { sheet: 0, row: 5, col: 4, value: 'd' },
        ],
      }),
      ALIGNED,
    );
    const edits = plan.rows.map((r) => [String(r.aligned) + r.side[0], [...r.edits.values()].join(''), r.receivesEdits]);
    expect(edits).toEqual([
      ['0o', '', true],
      ['1o', 'a', true],
      ['2o', '', true],
      ['1t', '', false],
      ['3t', 'b', true],
      ['4o', 'c', true],
      ['5o', 'd', true],
    ]);
  });

  it('値の違う列に打った値は、その列の採り方になる（相手側を採る列にも、未決定にも数えない）', () => {
    const plan = planSheet(rules({ cells: [{ sheet: 0, row: 1, col: 2, side: 'theirs' }], edits: [{ sheet: 0, row: 1, col: 1, value: 'x' }] }), ALIGNED);
    const row1 = plan.rows.find((r) => r.aligned === 1);
    expect([...(row1?.theirsCols ?? [])]).toEqual([2]);
    expect(row1?.undecidedCols.size).toBe(0);
    expect(row1?.edits.get(1)).toBe('x');
    expect(row1?.wholeTheirs).toBe(false);
  });
});

describe('キーと送る形', () => {
  it('送る形 ⇔ 引きの形は往復できる', () => {
    const dto: ConflictChoices = {
      cells: [{ sheet: 1, row: 2, col: 3, side: 'theirs' }],
      rows: [{ sheet: 0, row: 4, side: 'ours' }],
      cols: [{ sheet: 2, col: 1, side: 'theirs' }],
      rest: 'ours',
      edits: [{ sheet: 0, row: 1, col: 1, value: 'v' }],
      hunks: [{ sheet: 0, row: 1, end: 3, order: 'theirs-ours' }],
    };
    const m = choiceMapsOf(dto);
    expect(m.cells.get(cellKey(1, 2, 3))).toBe('theirs');
    expect(m.hunks.get(lineKey(0, 1))).toEqual({ end: 3, order: 'theirs-ours' });
    expect(toConflictChoices(m)).toEqual(dto);
    expect(hasAnyChoice(m)).toBe(true);
    expect(hasAnyChoice(maps())).toBe(false);
  });
});
