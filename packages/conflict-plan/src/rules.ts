/*
 * 1 シートの採り方の規則（決定 34・docs/07 7.1〜7.3）。**書き込み（core）とプレビュー・印（renderer）が同じものを使う。**
 *
 * 優先順位:
 *   - 両側にある行のセル: 両方を採用 > 打った値 > セル > 行 > 列 > 残りすべて
 *   - 片側にしか無い行:   両方を採用 > 行 > 残りすべて（行を入れるか入れないかの話なので、列やセルの指定とは噛み合わない）
 *
 * 両方を採用の範囲（hunks）:
 *   - 先頭の行が決めるべき所でなければ無視する
 *   - 先頭の行を含むブロックの中に切り詰める（少なくとも 1 行）
 *   - ブロックの先頭から順に見て、先の範囲に重なる範囲は無視する
 *
 * 引きの形（ChoiceMaps）のうち hunks と edits はここで 1 回だけ読んで索引にする。renderer は $derived の中で
 * 作り直すので、作る時点でこの 2 つを読むことが変更の購読になる。cells / rows / cols / rest は引くたびに読む。
 */

import { cellKey, lineKey } from './keys.js';
import { TargetIndex } from './targets.js';
import type { BlockReason, BothOrder, ChoiceMaps, ConflictSide, ConflictTargets, EffectiveChoice } from './types.js';

/** 効いている両方を採用の範囲 [start, end)。 */
export interface BothRange {
  readonly start: number;
  readonly end: number;
  readonly order: BothOrder;
}

/** 相手側（または打った値・両方を採用）を採れない所に、それが指定されている所。 */
export interface BlockedChoice {
  readonly row: number;
  /** 行全体なら -1。 */
  readonly col: number;
  readonly reason: BlockReason;
}

const NO_EDITS: ReadonlyMap<number, string> = new Map();

export class SheetRules {
  readonly index: TargetIndex;
  readonly #sheet: number;
  readonly #maps: ChoiceMaps;
  /** このシートの両方を採用の指定（先頭の行 → 範囲の終わりと並び）。 */
  readonly #hunks = new Map<number, { readonly end: number; readonly order: BothOrder }>();
  /** このシートの打った値（揃えた行 → 列 → 値）。 */
  readonly #edits = new Map<number, Map<number, string>>();
  /** ブロックの先頭 → 効いている範囲（作ったものを覚えておく）。 */
  readonly #ranges = new Map<number, readonly BothRange[]>();

  constructor(sheet: number, targets: ConflictTargets, maps: ChoiceMaps) {
    this.index = TargetIndex.of(targets);
    this.#sheet = sheet;
    this.#maps = maps;
    const prefix = `${String(sheet)}:`;
    for (const [key, block] of maps.hunks) {
      if (key.startsWith(prefix)) this.#hunks.set(Number(key.slice(prefix.length)), block);
    }
    for (const [key, value] of maps.edits) {
      if (!key.startsWith(prefix)) continue;
      const [row = 0, col = 0] = key.slice(prefix.length).split(':').map(Number);
      const inRow = this.#edits.get(row);
      if (inRow === undefined) this.#edits.set(row, new Map([[col, value]]));
      else inRow.set(col, value);
    }
  }

  get sheet(): number {
    return this.#sheet;
  }

  /** 行を含む、効いている両方を採用の範囲。無ければ null。 */
  blockAt(row: number): BothRange | null {
    if (this.#hunks.size === 0) return null;
    const start = this.index.hunkStart(row);
    if (start < 0) return null;
    for (const r of this.#rangesOf(start)) if (row >= r.start && row < r.end) return r;
    return null;
  }

  /** ブロックの中の効いている範囲（先頭から順に。重なる範囲は捨てる）。 */
  #rangesOf(start: number): readonly BothRange[] {
    const cached = this.#ranges.get(start);
    if (cached !== undefined) return cached;
    const end = this.index.hunkEnd(start);
    const out: BothRange[] = [];
    for (let i = start; i < end; ) {
      const h = this.#hunks.get(i);
      if (h === undefined) {
        i += 1;
        continue;
      }
      const e = Math.max(i + 1, Math.min(h.end, end));
      out.push({ start: i, end: e, order: h.order });
      i = e;
    }
    this.#ranges.set(start, out);
    return out;
  }

  /** 効いている両方を採用の範囲を全部（行の順）。 */
  bothRanges(): BothRange[] {
    const starts = new Set<number>();
    for (const row of this.#hunks.keys()) {
      const s = this.index.hunkStart(row);
      if (s >= 0) starts.add(s);
    }
    return [...starts].sort((a, b) => a - b).flatMap((s) => this.#rangesOf(s));
  }

  /** 両側にある行のセルの採り方。決まっていなければ null。 */
  cellChoice(row: number, col: number): EffectiveChoice | null {
    const both = this.blockAt(row);
    if (both !== null) return both.order;
    if (this.#edits.get(row)?.has(col) === true) return 'edit';
    const m = this.#maps;
    return m.cells.get(cellKey(this.#sheet, row, col)) ?? m.rows.get(lineKey(this.#sheet, row)) ?? m.cols.get(lineKey(this.#sheet, col)) ?? m.rest;
  }

  /** 片側にしか無い行の採り方。決まっていなければ null。 */
  rowChoice(row: number): EffectiveChoice | null {
    return this.blockAt(row)?.order ?? this.#maps.rows.get(lineKey(this.#sheet, row)) ?? this.#maps.rest;
  }

  /** 揃えた座標の採り方（片側にしか無い行は行の採り方）。 */
  choiceAt(row: number, col: number): EffectiveChoice | null {
    return this.index.isOneSided(row) ? this.rowChoice(row) : this.cellChoice(row, col);
  }

  /** 片側にしか無い行で、両方を採用の範囲の外の採り方（行 > 残り）。 */
  lineSide(row: number): ConflictSide | null {
    return this.#maps.rows.get(lineKey(this.#sheet, row)) ?? this.#maps.rest;
  }

  /** その行に打った値（列 → 値）。 */
  editsInRow(row: number): ReadonlyMap<number, string> {
    return this.#edits.get(row) ?? NO_EDITS;
  }

  /** 決まっていない決めるべき所の数。 */
  unresolved(): number {
    let n = 0;
    for (const t of this.index.targets()) if (this.choiceAt(t.row, t.col) === null) n += 1;
    return n;
  }

  /**
   * 相手側を採れない所に、相手側・打った値・両方を採用が指定されている所（行の順）。
   * 両方を採用できないシートでは、両方を採用の範囲そのものも数える（範囲の先頭の行・列 -1）。
   */
  blockedChoices(): BlockedChoice[] {
    const out: BlockedChoice[] = [];
    for (const b of this.index.blocked) {
      const c = this.choiceAt(b.row, b.col);
      if (c !== null && c !== 'ours') out.push(b);
    }
    const reason = this.index.bothBlocked;
    if (reason !== null) for (const r of this.bothRanges()) out.push({ row: r.start, col: -1, reason });
    return out.sort((a, b) => a.row - b.row || a.col - b.col);
  }
}

/** ブック全体の未決定の数。 */
export function unresolvedCount(rules: readonly SheetRules[]): number {
  let n = 0;
  for (const r of rules) n += r.unresolved();
  return n;
}

/** ブック全体の採れない所の指定の数と、最初のもの（シートの順 → 行の順）。 */
export function blockedChoicesOf(rules: readonly SheetRules[]): {
  readonly count: number;
  readonly first: (BlockedChoice & { readonly sheet: number }) | null;
} {
  let count = 0;
  let first: (BlockedChoice & { readonly sheet: number }) | null = null;
  for (const r of rules) {
    const list = r.blockedChoices();
    count += list.length;
    const head = list[0];
    if (first === null && head !== undefined) first = { ...head, sheet: r.sheet };
  }
  return { count, first };
}
