/*
 * 1 シートの決めるべき所の引き（決定 34）。
 *
 * **ブロック** = 決めるべき所のある行が続く区間。両方を採用の範囲はブロックの中に切り詰める（docs/07 7.2）。
 * 両側にある行は値の違う列があるときだけ決めるべき所になり、片側にしか無い行は必ずなるので、
 * これは比較の「違いのある行」（rowState が SAME でない行）が続く区間と同じ（core のテストで確かめる）。
 */

import type { BlockReason, BlockedTarget, ConflictTargets } from './types.js';

const NO_COLS: readonly number[] = [];

export class TargetIndex {
  /** 概要（ConflictTargets）ごとに 1 回だけ作る。 */
  static of(targets: ConflictTargets): TargetIndex {
    let index = cache.get(targets);
    if (index === undefined) {
      index = new TargetIndex(targets);
      cache.set(targets, index);
    }
    return index;
  }

  readonly bothBlocked: BlockReason | null;
  readonly blocked: readonly BlockedTarget[];
  /** 決めるべき所のある行（昇順・重複なし）。 */
  readonly rows: readonly number[];
  readonly #targets: ConflictTargets;
  /** 両側にある行 → 値の違う列（昇順）。 */
  readonly #cols = new Map<number, number[]>();
  readonly #oneSided: ReadonlySet<number>;
  /** 行 → 属するブロックの先頭。 */
  readonly #start = new Map<number, number>();
  /** ブロックの先頭 → 終わり（含まない）。 */
  readonly #end = new Map<number, number>();
  readonly #blockedAt = new Map<string, BlockReason>();

  private constructor(targets: ConflictTargets) {
    this.#targets = targets;
    this.bothBlocked = targets.bothBlocked ?? null;
    this.blocked = targets.blocked;
    this.#oneSided = new Set(targets.rows);
    const cells = targets.cells;
    for (let k = 0; k + 1 < cells.length; k += 2) {
      const row = cells[k] ?? 0;
      const list = this.#cols.get(row);
      if (list === undefined) this.#cols.set(row, [cells[k + 1] ?? 0]);
      else list.push(cells[k + 1] ?? 0);
    }
    this.rows = [...new Set([...this.#cols.keys(), ...targets.rows])].sort((a, b) => a - b);
    let start = -1;
    let prev = -2;
    for (const row of this.rows) {
      if (row !== prev + 1) {
        if (start >= 0) this.#end.set(start, prev + 1);
        start = row;
      }
      this.#start.set(row, start);
      prev = row;
    }
    if (start >= 0) this.#end.set(start, prev + 1);
    for (const b of targets.blocked) this.#blockedAt.set(`${String(b.row)}:${String(b.col)}`, b.reason);
  }

  isOneSided(row: number): boolean {
    return this.#oneSided.has(row);
  }

  /** 決めるべき所か。片側にしか無い行は、どの列でも（列 -1 でも）その行全体が決めるべき所。 */
  isTarget(row: number, col: number): boolean {
    return this.#oneSided.has(row) || (this.#cols.get(row)?.includes(col) ?? false);
  }

  /** 行の属するブロックの先頭。決めるべき所の無い行なら -1。 */
  hunkStart(row: number): number {
    return this.#start.get(row) ?? -1;
  }

  /** ブロックの終わり（含まない）。start がブロックの先頭でなければ start。 */
  hunkEnd(start: number): number {
    return this.#end.get(start) ?? start;
  }

  /** 両側にある行の値の違う列（昇順）。 */
  changedCols(row: number): readonly number[] {
    return this.#cols.get(row) ?? NO_COLS;
  }

  /** 決めるべき所を行・列の順に（片側にしか無い行は col = -1）。 */
  *targets(): Generator<{ readonly row: number; readonly col: number }> {
    const { cells, rows } = this.#targets;
    let k = 0;
    let r = 0;
    for (;;) {
      const cellRow = k + 1 < cells.length ? (cells[k] ?? Infinity) : Infinity;
      const lineRow = r < rows.length ? (rows[r] ?? Infinity) : Infinity;
      if (cellRow === Infinity && lineRow === Infinity) return;
      if (lineRow < cellRow) {
        yield { row: lineRow, col: -1 };
        r += 1;
      } else {
        yield { row: cellRow, col: cells[k + 1] ?? 0 };
        k += 2;
      }
    }
  }

  /** その所で相手側を採れない理由。片側にしか無い行は列を問わず行全体の理由。採れるなら null。 */
  blockReasonAt(row: number, col: number): BlockReason | null {
    const c = this.#oneSided.has(row) ? -1 : col;
    return this.#blockedAt.get(`${String(row)}:${String(c)}`) ?? null;
  }
}

const cache = new WeakMap<ConflictTargets, TargetIndex>();
