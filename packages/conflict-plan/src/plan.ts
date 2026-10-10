/*
 * 書き込み後の行の並び（docs/07 5.1・7.2・7.3）。**書き込み（core）とプレビュー（renderer）が同じものを使う。**
 *
 *   - 違いの無い行（same）: 自分側の行。打った値があれば当てる
 *   - 両側にある値の違う行（cells）: 自分側の行を土台に、相手側を採った列（theirsCols）を差し替え、打った値を当てる
 *   - 両方を採用の範囲（both）: 範囲の自分側の行を全部、続けて相手側の行を全部（または逆）。
 *     打った値は自分側の版に、自分側の行が無ければ相手側の版に当てる
 *   - 片側にしか無い行: その行がある側を採れば出し（line）、無い側を採れば出さない。決めていなければ undecided
 *
 * 決まっていない所が残れば unresolved > 0 で、書き込みはしない（プレビューは印を付けて出す）。
 */

import type { SheetRules } from './rules.js';
import type { BothOrder, ConflictSide } from './types.js';

export type PlanRowKind = 'same' | 'cells' | 'both' | 'line' | 'undecided';

export interface PlanRow {
  readonly kind: PlanRowKind;
  /** どちらの側の行を出すか（cells は自分側を土台にする）。 */
  readonly side: ConflictSide;
  /** 揃えた行。 */
  readonly aligned: number;
  /** side の側の行番号。 */
  readonly row: number;
  /** same / cells のとき相手側の行番号。それ以外は -1。 */
  readonly theirsRow: number;
  /** cells のとき相手側を採る列。 */
  readonly theirsCols: ReadonlySet<number>;
  /** cells のとき決まっていない列。 */
  readonly undecidedCols: ReadonlySet<number>;
  /** この行に書く打った値（列 → 値）。 */
  readonly edits: ReadonlyMap<number, string>;
  /** その揃えた行に打った値がこの行に当たるか（両方を採用で、自分側の行がある相手側の版だけ false）。 */
  readonly receivesEdits: boolean;
  /** cells で、値の違う列が全部相手側（打った値も無い）。CSV は相手側のレコードを丸ごと使える。 */
  readonly wholeTheirs: boolean;
}

export interface SheetPlan {
  readonly rows: readonly PlanRow[];
  /** 決まっていない所の数（セル、または片側にしか無い行）。 */
  readonly unresolved: number;
  /** 自分側から何か変わるか（相手側を採った・打った値・両方を採用・行の挿入や削除）。 */
  readonly touched: boolean;
}

/** 揃えた行ごとの両側の行番号（無い側は -1）。core の SheetComparison・renderer の幾何がそのまま満たす。 */
export interface AlignedRows {
  readonly oldRow: ArrayLike<number>;
  readonly newRow: ArrayLike<number>;
}

// same の行は共有の空の入れ物を使う（100 万行でも割り当てない）
const NO_COLS: ReadonlySet<number> = new Set();
const NO_EDITS: ReadonlyMap<number, string> = new Map();

export function planSheet(rules: SheetRules, aligned: AlignedRows): SheetPlan {
  const index = rules.index;
  const rows: PlanRow[] = [];
  let unresolved = 0;
  let touched = false;
  const count = aligned.oldRow.length;

  const line = (kind: PlanRowKind, side: ConflictSide, i: number, row: number, receivesEdits: boolean): PlanRow => ({
    kind,
    side,
    aligned: i,
    row,
    theirsRow: -1,
    theirsCols: NO_COLS,
    undecidedCols: NO_COLS,
    edits: receivesEdits ? rules.editsInRow(i) : NO_EDITS,
    receivesEdits,
    wholeTheirs: false,
  });

  const pushBoth = (from: number, to: number, order: BothOrder): void => {
    const ours: PlanRow[] = [];
    const theirs: PlanRow[] = [];
    for (let i = from; i < to; i += 1) {
      const o = aligned.oldRow[i] ?? -1;
      const n = aligned.newRow[i] ?? -1;
      if (o >= 0) ours.push(line('both', 'ours', i, o, true));
      if (n >= 0) theirs.push(line('both', 'theirs', i, n, o < 0));
    }
    rows.push(...(order === 'ours-theirs' ? [...ours, ...theirs] : [...theirs, ...ours]));
    touched = true;
  };

  for (let i = 0; i < count; i += 1) {
    const o = aligned.oldRow[i] ?? -1;
    const n = aligned.newRow[i] ?? -1;
    const start = index.hunkStart(i);

    if (start < 0) {
      // 違いの無い行（両側にある）
      const edits = rules.editsInRow(i);
      if (edits.size > 0) touched = true;
      rows.push({
        kind: 'same',
        side: 'ours',
        aligned: i,
        row: o,
        theirsRow: n,
        theirsCols: NO_COLS,
        undecidedCols: NO_COLS,
        edits,
        receivesEdits: true,
        wholeTheirs: false,
      });
      continue;
    }

    // 両方を採用の範囲は先頭の行で出して、末尾まで飛ばす
    const both = rules.blockAt(i);
    if (both !== null && both.start === i) {
      pushBoth(i, both.end, both.order);
      i = both.end - 1;
      continue;
    }

    if (index.isOneSided(i)) {
      const present: ConflictSide = o >= 0 ? 'ours' : 'theirs';
      const side = rules.lineSide(i);
      if (side === null) {
        unresolved += 1;
        rows.push(line('undecided', present, i, o >= 0 ? o : n, true));
      } else if (side === present) {
        // 自分側の行を残すのは、打った値が無ければ何も変えない
        if (present === 'theirs' || rules.editsInRow(i).size > 0) touched = true;
        rows.push(line('line', present, i, o >= 0 ? o : n, true));
      } else if (present === 'ours') {
        // 自分側の行を落とす（相手側の行が無い側を採った）
        touched = true;
      }
      continue;
    }

    // 両側にある値の違う行: 列ごとに
    const theirsCols = new Set<number>();
    const undecidedCols = new Set<number>();
    const typed = rules.editsInRow(i);
    const changed = index.changedCols(i);
    for (const col of changed) {
      if (typed.has(col)) continue;
      const c = rules.cellChoice(i, col);
      if (c === null) undecidedCols.add(col);
      else if (c === 'theirs') theirsCols.add(col);
    }
    unresolved += undecidedCols.size;
    if (theirsCols.size > 0 || typed.size > 0) touched = true;
    rows.push({
      kind: 'cells',
      side: 'ours',
      aligned: i,
      row: o,
      theirsRow: n,
      theirsCols,
      undecidedCols,
      edits: typed,
      receivesEdits: true,
      wholeTheirs: changed.length > 0 && theirsCols.size === changed.length && typed.size === 0,
    });
  }
  return { rows, unresolved, touched };
}

/** 揃えた行 → 並びで最初に出る位置（出ない行は無し）。 */
export function planIndexOf(rows: readonly PlanRow[]): Map<number, number> {
  const out = new Map<number, number>();
  rows.forEach((r, k) => {
    if (!out.has(r.aligned)) out.set(r.aligned, k);
  });
  return out;
}
