/*
 * Excel 差分モードのコンフリクトの採り方（決定 34）。ExcelState が 1 つ持つ。
 *
 * キーは揃えた座標（@feathertree/conflict-plan の cellKey / lineKey）。conflict-plan の ChoiceMaps を満たすので、
 * そのまま SheetRules に渡せる（SvelteMap を読むので、規則を作り直す $derived が変更を購読する）。
 *
 * **比較の出どころ（パス・source・指紋）が同じ間だけ持ち越す**——更新・ウィンドウ復帰ではトークンが変わるが、
 * 比べているものが同じなら揃え方も同じなので、決めたものを捨てない。書き込んだ（指紋が変わった）・別のファイルに
 * 替えたら捨てる。
 */

import {
  cellKey,
  lineKey,
  toConflictChoices,
  type BothBlock,
  type BothOrder,
  type ChoiceMaps,
  type ConflictSide,
} from '@feathertree/conflict-plan';
import type { ExcelCellChoicesDto, ExcelViewDto } from '@feathertree/ipc';
import { SvelteMap } from 'svelte/reactivity';

/** 両方を採用の単位（ブロックごとの、選んだ行の続いた範囲）。 */
export interface RowSpan {
  readonly start: number;
  readonly end: number;
}

export class ConflictChoices implements ChoiceMaps {
  /** キーは `シート:揃えた行:列`。 */
  readonly cells = new SvelteMap<string, ConflictSide>();
  /** 片側にしか無い行の指定。キーは `シート:揃えた行`。 */
  readonly rows = new SvelteMap<string, ConflictSide>();
  /** キーは `シート:列`。 */
  readonly cols = new SvelteMap<string, ConflictSide>();
  /** 個別に決めていない残りすべて（ブック全体）。 */
  rest = $state<ConflictSide | null>(null);
  /** 打った値（docs/07 7.1・7.3）。キーは `シート:揃えた行:列`。 */
  readonly edits = new SvelteMap<string, string>();
  /** 続いた行の範囲で両方を採用（docs/07 7.2）。キーは `シート:範囲の先頭の揃えた行`。 */
  readonly hunks = new SvelteMap<string, BothBlock>();
  #key: string | null = null;

  /** ビューを取り直した。同じファイルの同じ比較でなければ捨てる。 */
  sync(view: ExcelViewDto): void {
    const conflict = view.conflict ?? null;
    const key = conflict === null ? null : `${view.path}|${conflict.source}|${conflict.fingerprint}`;
    if (key === this.#key) return;
    this.#key = key;
    this.clear();
  }

  /** タブを替えた等。何も持ち越さない。 */
  forget(): void {
    this.#key = null;
    this.clear();
  }

  clear(): void {
    this.cells.clear();
    this.rows.clear();
    this.cols.clear();
    this.rest = null;
    this.edits.clear();
    this.hunks.clear();
  }

  /**
   * 決めるべき所に片側を当てる（null なら個別の指定を外す）。打った値と、掛かる両方を採用は外す
   * （そちらが強いので、残すと効かない）。
   */
  applySide(
    sheet: number,
    targets: { readonly cells: readonly { row: number; col: number }[]; readonly rows: readonly number[] },
    spans: readonly RowSpan[],
    side: ConflictSide | null,
  ): void {
    for (const b of spans) this.dropBoth(sheet, b.start, b.end);
    for (const c of targets.cells) {
      const key = cellKey(sheet, c.row, c.col);
      this.edits.delete(key);
      if (side === null) this.cells.delete(key);
      else this.cells.set(key, side);
    }
    for (const r of targets.rows) {
      const key = lineKey(sheet, r);
      if (side === null) this.rows.delete(key);
      else this.rows.set(key, side);
    }
  }

  /** 範囲ごとに両方を採用する。同じ範囲に同じ並びが既にあれば外す（押し直し）。重なる範囲は置き換える。 */
  applyBoth(sheet: number, spans: readonly RowSpan[], order: BothOrder): void {
    for (const b of spans) {
      const same = this.hunks.get(lineKey(sheet, b.start));
      this.dropBoth(sheet, b.start, b.end);
      if (same?.end === b.end && same.order === order) continue;
      this.hunks.set(lineKey(sheet, b.start), { end: b.end, order });
    }
  }

  /** [start, end) と重なる両方を採用を外す。 */
  dropBoth(sheet: number, start: number, end: number): void {
    const prefix = String(sheet) + ':';
    for (const [key, block] of [...this.hunks]) {
      if (!key.startsWith(prefix)) continue;
      const s = Number(key.slice(prefix.length));
      if (s < end && block.end > start) this.hunks.delete(key);
    }
  }

  editOf(sheet: number, row: number, col: number): string | undefined {
    return this.edits.get(cellKey(sheet, row, col));
  }

  setEdit(sheet: number, row: number, col: number, value: string): void {
    this.edits.set(cellKey(sheet, row, col), value);
  }

  /** 送る形（main は座標と側・打った値だけを受け取る）。 */
  toDto(): ExcelCellChoicesDto {
    return toConflictChoices(this);
  }
}
