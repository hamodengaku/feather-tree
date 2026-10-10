/*
 * Excel のコンフリクトの採り方（決定 34・docs/07）の型。
 *
 * ipc の DTO・core の型は import しない。**構造的に**同じ形にしてあるので、どちらもそのまま渡せる
 * （renderer は ipc の DTO を、core は自分の型を渡す）。
 */

export type ConflictSide = 'ours' | 'theirs';

/** 両方を採用するときの並び（git の ours → theirs / theirs → ours）。docs/07 7.2。 */
export type BothOrder = 'ours-theirs' | 'theirs-ours';

/**
 * 相手側を採れない理由（docs/07 3.2）。
 *  - sheet-structure … 片側にしか無いシート
 *  - array-formula   … 配列数式・データテーブルのセル、その範囲の内側への行の挿入・削除
 *  - table-header    … テーブルの見出しのセル・見出しの行の削除
 *  - unsafe-part     … 行のずらし方が分からない部品（ピボット等）を持つシートの行の挿入・削除
 */
export type BlockReason = 'sheet-structure' | 'array-formula' | 'table-header' | 'unsafe-part';

/** 効いている採り方。edit は利用者が打った値（docs/07 7.1）、ours-theirs / theirs-ours は両方を採用（7.2）。 */
export type EffectiveChoice = ConflictSide | 'edit' | BothOrder;

export interface BlockedTarget {
  readonly row: number;
  /** -1 なら行全体（片側にしか無い行）。 */
  readonly col: number;
  readonly reason: BlockReason;
}

/** 1 シートの「決めるべき所」と「相手側を採れない所」。座標は揃えた行・列。 */
export interface ConflictTargets {
  /** 両側にある行で値が違うセル（揃えた行, 列 の組の平らな並び。行・列の昇順）。 */
  readonly cells: readonly number[];
  /** 片側にしか無い揃えた行（行全体で決める。昇順）。 */
  readonly rows: readonly number[];
  readonly blocked: readonly BlockedTarget[];
  /** 両方を採用できないシートなら、その理由（行の挿入になるため）。省略・null は採用できる。 */
  readonly bothBlocked?: BlockReason | null;
}

/** 両方を採用する範囲の終わり（含まない）と並び。 */
export interface BothBlock {
  readonly end: number;
  readonly order: BothOrder;
}

/**
 * セル・行・列単位の採り方（送る形。ipc の ExcelCellChoicesDto と同じ形）。sheet はシートの添字、行・列は揃えた座標。
 * 優先順位は 両方を採用 > 打った値 > セル > 行 > 列 > 残りすべて。片側にしか無い行は 両方を採用 > 行 > 残りすべて。
 */
export interface ConflictChoices {
  readonly cells: readonly { readonly sheet: number; readonly row: number; readonly col: number; readonly side: ConflictSide }[];
  /** 行の指定（片側だけ。両方の採用は hunks で）。 */
  readonly rows: readonly { readonly sheet: number; readonly row: number; readonly side: ConflictSide }[];
  readonly cols: readonly { readonly sheet: number; readonly col: number; readonly side: ConflictSide }[];
  readonly rest: ConflictSide | null;
  /** 利用者が打った値（docs/07 7.1・7.3）。 */
  readonly edits?: readonly { readonly sheet: number; readonly row: number; readonly col: number; readonly value: string }[];
  /** 続いた行の範囲 [row, end) で両方を採用する（docs/07 7.2）。 */
  readonly hunks?: readonly { readonly sheet: number; readonly row: number; readonly end: number; readonly order: BothOrder }[];
}

/**
 * 採り方の引きの形。キーは keys.ts の cellKey（`シート:行:列`）/ lineKey（`シート:行` / `シート:列`）。
 * renderer の SvelteMap がそのまま満たす。
 */
export interface ChoiceMaps {
  readonly cells: ReadonlyMap<string, ConflictSide>;
  readonly rows: ReadonlyMap<string, ConflictSide>;
  readonly cols: ReadonlyMap<string, ConflictSide>;
  readonly rest: ConflictSide | null;
  readonly edits: ReadonlyMap<string, string>;
  /** キーは `シート:範囲の先頭の行`。 */
  readonly hunks: ReadonlyMap<string, BothBlock>;
}
