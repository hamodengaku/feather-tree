/*
 * Excel 差分モードのコンフリクトの採用（決定 34）。作業ツリーへ書き戻すだけで、index には触れない。
 *
 *   - ファイル単位（ブック・CSV）: 採る側をそのまま書く
 *       - CSV のマーカー方式 … 作業ツリーを読み直し、全ブロックをその側で解いたもの（git は 0）
 *       - 段の方式（ブック）  … 採る側の段を #49 で読み直したもの（1 プロセス）
 *   - セル・行・列単位:
 *       - CSV（マーカー方式） … 行ごとの採り方を決め、欄のバイト列を継ぎ合わせる
 *       - ブック（段の方式）  … 行の並び・行の対応を決め、自分側を土台に書き換える（docs/07-xlsx-cell-merge.md）
 *
 * renderer から受け取るのは**座標と側だけ**。本文は main が読み直したものから作る（決定 30 の採用・
 * hunk のステージと同じ。決定「やらないこと」のパッチ文字列の項）。書く直前に作業ツリー（ブックなら両側の段も）を
 * 読み直し、比較を作ったときと同じバイト列か照合する。
 */

import {
  FORMULA_ARRAY,
  FORMULA_DATA_TABLE,
  ROW_CHANGED,
  ROW_SAME,
  XlsxMergeError,
  changedColumns,
  composeCsv,
  decodeCsv,
  encodeCsvField,
  mergeXlsx,
  splitCsvConflict,
  type CellData,
  type CsvRowPlan,
  type OutRow,
  type SheetComparison,
  type SheetInspection,
  type XlsxSheetMerge,
} from '@feathertree/excel';
import {
  WorktreeFileLockedError,
  readBlobFiltered,
  readWorktreeBytes,
  writeWorktreeBytes,
  type GitContext,
} from '@feathertree/git';
import { ConflictUnsupportedError, StaleDiffError } from './sessionErrors.js';
import { hashOf, worktreeFingerprint, type ExcelComparison } from './excelView.js';
import { zlibDeflater, zlibInflater } from './zlibInflater.js';

export type ExcelConflictSide = 'ours' | 'theirs';

/** 両方を採用するときの並び（git の ours → theirs / theirs → ours）。docs/07 7.2。 */
export type ExcelBothOrder = 'ours-theirs' | 'theirs-ours';

/** 行の指定。両側にある行なら、両方を採用して 2 行に分けられる。 */
export type ExcelRowChoice = ExcelConflictSide | ExcelBothOrder;

/**
 * セル・行・列単位の採り方。優先順位はセル > 行 > 列 > 残りすべて。
 * sheet は比較の中のシートの添字、行・列は揃えた座標。rest はブック全体に効く。
 */
export interface ExcelCellChoices {
  readonly cells: readonly { readonly sheet: number; readonly row: number; readonly col: number; readonly side: ExcelConflictSide }[];
  readonly rows: readonly { readonly sheet: number; readonly row: number; readonly side: ExcelRowChoice }[];
  readonly cols: readonly { readonly sheet: number; readonly col: number; readonly side: ExcelConflictSide }[];
  readonly rest: ExcelConflictSide | null;
  /**
   * 利用者が打った値（docs/07 7.1）。両側にある行の値の違うセルにだけ効き、セルの指定より強い。
   * 省略は「無し」（CSV の第 1 段階からの呼び出しの互換）。
   */
  readonly edits?: readonly { readonly sheet: number; readonly row: number; readonly col: number; readonly value: string }[];
  /**
   * 続いた行の範囲 [row, end) で両方を採用する（docs/07 7.2）。範囲はブロック（違いのある行が続く区間）の中に
   * 収まるよう切り詰める。範囲の中のどの指定よりも強い。
   */
  readonly hunks?: readonly { readonly sheet: number; readonly row: number; readonly end: number; readonly order: ExcelBothOrder }[];
}

const isBoth = (c: ExcelRowChoice | undefined): c is ExcelBothOrder => c === 'ours-theirs' || c === 'theirs-ours';

/**
 * 揃えた行ごとの、属するブロックの先頭（違いの無い行は -1）。ブロックは違いのある行が続く区間。
 * renderer も同じ区切り方をする（決めるべき所の行が続く区間）。
 */
export function hunkStartsOf(sheet: SheetComparison): Int32Array {
  const out = new Int32Array(sheet.oldRow.length).fill(-1);
  let start = -1;
  for (let i = 0; i < sheet.oldRow.length; i += 1) {
    if ((sheet.rowState[i] ?? ROW_SAME) === ROW_SAME) {
      start = -1;
      continue;
    }
    if (start < 0) start = i;
    out[i] = start;
  }
  return out;
}

/** 両方を採用する範囲の終わり（含まない）。i を含むブロックの中に切り詰め、少なくとも 1 行。 */
function blockEnd(starts: Int32Array, i: number, end: number): number {
  let e = i + 1;
  while (e < end && e < starts.length && starts[e] === starts[i]) e += 1;
  return e;
}

/** 両方を採用するブロック・行を、出す行の並びにする（自分側の行どうし・相手側の行どうしの順は保つ）。 */
function bothRows(sheet: SheetComparison, from: number, to: number, order: ExcelBothOrder): { kind: 'ours' | 'theirs'; row: number; aligned: number }[] {
  const ours: { kind: 'ours'; row: number; aligned: number }[] = [];
  const theirs: { kind: 'theirs'; row: number; aligned: number }[] = [];
  for (let i = from; i < to; i += 1) {
    const o = sheet.oldRow[i] ?? -1;
    const n = sheet.newRow[i] ?? -1;
    if (o >= 0) ours.push({ kind: 'ours', row: o, aligned: i });
    if (n >= 0) theirs.push({ kind: 'theirs', row: n, aligned: i });
  }
  return order === 'ours-theirs' ? [...ours, ...theirs] : [...theirs, ...ours];
}

export type ExcelResolveRequest =
  | { readonly kind: 'file'; readonly side: ExcelConflictSide }
  | { readonly kind: 'cells'; readonly choices: ExcelCellChoices };

/** 書き戻しに要るものだけ。`RepositorySession` がこれを満たす。 */
export interface ExcelResolveSource {
  context(signal?: AbortSignal): GitContext;
  track<T>(args: readonly string[], run: () => Promise<T>): Promise<T>;
}

/** 採り方の引き。 */
class Choices {
  readonly #cells = new Map<string, ExcelConflictSide>();
  readonly #rows = new Map<string, ExcelRowChoice>();
  readonly #hunks = new Map<string, { readonly end: number; readonly order: ExcelBothOrder }>();
  readonly #cols = new Map<string, ExcelConflictSide>();
  readonly #rest: ExcelConflictSide | null;
  readonly #edits = new Map<string, string>();
  /** 行ごとの打った値（列 → 値）。値の違う所に限らず、出力のどのセルにも当てる（docs/07 7.3）。 */
  readonly #rowEdits = new Map<string, Map<number, string>>();

  constructor(choices: ExcelCellChoices) {
    for (const e of choices.edits ?? []) {
      this.#edits.set(`${String(e.sheet)}:${String(e.row)}:${String(e.col)}`, e.value);
      const key = `${String(e.sheet)}:${String(e.row)}`;
      const row = this.#rowEdits.get(key) ?? new Map<number, string>();
      row.set(e.col, e.value);
      this.#rowEdits.set(key, row);
    }
    for (const c of choices.cells) this.#cells.set(`${String(c.sheet)}:${String(c.row)}:${String(c.col)}`, c.side);
    for (const r of choices.rows) this.#rows.set(`${String(r.sheet)}:${String(r.row)}`, r.side);
    for (const c of choices.cols) this.#cols.set(`${String(c.sheet)}:${String(c.col)}`, c.side);
    this.#rest = choices.rest;
    for (const h of choices.hunks ?? []) this.#hunks.set(`${String(h.sheet)}:${String(h.row)}`, { end: h.end, order: h.order });
  }

  /** その行から始まる「両方を採用」の範囲。無ければ null。 */
  block(sheet: number, row: number): { readonly end: number; readonly order: ExcelBothOrder } | null {
    return this.#hunks.get(`${String(sheet)}:${String(row)}`) ?? null;
  }

  /** 行で両方を採用するなら、その並び（両側にある行だけ）。 */
  rowBoth(sheet: number, row: number): ExcelBothOrder | null {
    const c = this.#rows.get(`${String(sheet)}:${String(row)}`);
    return isBoth(c) ? c : null;
  }

  /** 行の指定のうち、片側を採るもの。 */
  #rowSide(sheet: number, row: number): ExcelConflictSide | undefined {
    const c = this.#rows.get(`${String(sheet)}:${String(row)}`);
    return isBoth(c) ? undefined : c;
  }

  cell(sheet: number, row: number, col: number): ExcelConflictSide | null {
    const s = String(sheet);
    return (
      this.#cells.get(`${s}:${String(row)}:${String(col)}`) ??
      this.#rowSide(sheet, row) ??
      this.#cols.get(`${s}:${String(col)}`) ??
      this.#rest
    );
  }

  /** その行に打った値（列 → 値）。無ければ空。 */
  editsInRow(sheet: number, row: number): ReadonlyMap<number, string> {
    return this.#rowEdits.get(`${String(sheet)}:${String(row)}`) ?? new Map<number, string>();
  }

  /** そのセルに打った値。無ければ undefined。 */
  edit(sheet: number, row: number, col: number): string | undefined {
    return this.#edits.get(`${String(sheet)}:${String(row)}:${String(col)}`);
  }

  /**
   * 片側にしか無い行（行 > 残りすべて）。両方を採用する指定は「その行を残す」（行がある側を採る）と同じ。
   */
  row(sheet: number, row: number, presentSide: ExcelConflictSide): ExcelConflictSide | null {
    const c = this.#rows.get(`${String(sheet)}:${String(row)}`);
    if (isBoth(c)) return presentSide;
    return c ?? this.#rest;
  }
}

export interface CsvPlanResult {
  readonly plans: readonly CsvRowPlan[];
  /** 決まっていない違い（セル、または片側にしか無い行）の数。 */
  readonly unresolved: number;
}

/**
 * CSV の揃えた行ごとの採り方を決める（純関数）。シートは 1 枚（添字 0）。
 *
 *   - 両側にある行: 値の違う列ごとに「セル > 行 > 列 > 残り」で側を引く。全部が同じ側なら、その側の
 *     レコードを丸ごと使う（元のバイトのまま）。混ざれば欄を継ぎ合わせる。違いが無ければ自分側
 *   - 片側にしか無い行: 「行 > 残り」で決める（列やセルの指定は効かない。行を入れるか入れないかの話なので）。
 *     その行がある側を採れば入れ、無い側を採れば落とす
 */
export function planCsvResolution(
  view: ExcelComparison,
  choices: ExcelCellChoices,
  /** 打った値を欄にする（引用符と文字コード）。書けなければ null。 */
  encodeField: (text: string) => Uint8Array | null = () => null,
): CsvPlanResult {
  const sheet = view.comparison.sheets[0];
  if (sheet === undefined || view.comparison.sheets.length !== 1) return { plans: [], unresolved: 0 };
  const pick = new Choices(choices);
  const oldData = sheet.old?.data ?? null;
  const newData = sheet.new?.data ?? null;
  const sstOld = view.comparison.old?.sst ?? [];
  const sstNew = view.comparison.new?.sst ?? [];

  const plans: CsvRowPlan[] = [];
  let unresolved = 0;
  const starts = hunkStartsOf(sheet);

  const encodeAll = (values: ReadonlyMap<number, string>): Map<number, Uint8Array> => {
    const out = new Map<number, Uint8Array>();
    for (const [col, text] of values) {
      const field = encodeField(text);
      if (field === null) throw new ConflictUnsupportedError('打った値に、このファイルの文字コードで書けない文字があります。');
      out.set(col, field);
    }
    return out;
  };
  /** 片側の行を丸ごと出す。その揃えた行に打った値があれば、その欄だけ差し替える（docs/07 7.3）。 */
  const pushRow = (kind: 'ours' | 'theirs', row: number, aligned: number, withEdits: boolean): void => {
    const typed = withEdits ? pick.editsInRow(0, aligned) : new Map<number, string>();
    if (typed.size === 0) {
      plans.push({ kind, row });
      return;
    }
    const edits = encodeAll(typed);
    plans.push(
      kind === 'ours'
        ? { kind: 'mixed', oursRow: row, theirsRow: -1, theirsCols: new Set(), edits }
        : { kind: 'mixed', oursRow: -1, theirsRow: row, theirsCols: new Set(), edits },
    );
  };
  /** 両方を採用: 打った値は自分側の版（無ければ相手側の版）にだけ当てる。 */
  const pushBoth = (from: number, to: number, order: ExcelBothOrder): void => {
    for (const r of bothRows(sheet, from, to, order)) {
      const hasOurs = (sheet.oldRow[r.aligned] ?? -1) >= 0;
      pushRow(r.kind, r.row, r.aligned, r.kind === 'ours' || !hasOurs);
    }
  };

  for (let i = 0; i < sheet.oldRow.length; i += 1) {
    const o = sheet.oldRow[i] ?? -1;
    const n = sheet.newRow[i] ?? -1;
    // 両方を採用する範囲: 先頭の行で範囲（ブロックの中に切り詰め）を出して、末尾まで飛ばす
    const blk = (starts[i] ?? -1) >= 0 ? pick.block(0, i) : null;
    if (blk !== null) {
      const end = blockEnd(starts, i, blk.end);
      pushBoth(i, end, blk.order);
      i = end - 1;
      continue;
    }
    if (o < 0 || n < 0) {
      const side = pick.row(0, i, o >= 0 ? 'ours' : 'theirs');
      if (side === null) {
        unresolved += 1;
        continue;
      }
      if (side === 'ours' && o >= 0) pushRow('ours', o, i, true);
      if (side === 'theirs' && n >= 0) pushRow('theirs', n, i, true);
      continue;
    }
    if ((sheet.rowState[i] ?? ROW_SAME) === ROW_SAME) {
      pushRow('ours', o, i, true);
      continue;
    }
    const rowOrder = pick.rowBoth(0, i);
    if (rowOrder !== null) {
      pushBoth(i, i + 1, rowOrder);
      continue;
    }
    const changed = changedColumns(oldData?.rows[o]?.cells, sstOld, newData?.rows[n]?.cells, sstNew);
    const theirsCols = new Set<number>();
    const edits = new Map<number, Uint8Array>();
    let fromOurs = 0;
    let missing = 0;
    for (const col of changed) {
      const typed = pick.edit(0, i, col);
      if (typed !== undefined) {
        const field = encodeField(typed);
        if (field === null) throw new ConflictUnsupportedError('打った値に、このファイルの文字コードで書けない文字があります。');
        edits.set(col, field);
        continue;
      }
      const side = pick.cell(0, i, col);
      if (side === null) missing += 1;
      else if (side === 'theirs') theirsCols.add(col);
      else fromOurs += 1;
    }
    if (missing > 0) {
      unresolved += missing;
      continue;
    }
    // 値の違わない欄に打った値も書く（プレビューでの編集）
    for (const [col, field] of encodeAll(pick.editsInRow(0, i))) if (!edits.has(col)) edits.set(col, field);
    if (edits.size > 0) plans.push({ kind: 'mixed', oursRow: o, theirsRow: n, theirsCols, edits });
    else if (theirsCols.size === 0) plans.push({ kind: 'ours', row: o });
    else if (fromOurs === 0) plans.push({ kind: 'theirs', row: n });
    else plans.push({ kind: 'mixed', oursRow: o, theirsRow: n, theirsCols });
  }
  return { plans, unresolved };
}

/** 画面に一覧で送る衝突セルの上限（ブック全体）。超えたら送らず、ファイル単位で採ってもらう。 */
export const MAX_CONFLICT_CELLS = 200_000;

/**
 * 相手側を採れない理由（docs/07 3.2）。
 *  - sheet-structure … 片側にしか無いシート
 *  - array-formula   … 配列数式・データテーブルのセル、その範囲の内側への行の挿入・削除
 *  - table-header    … テーブルの見出しのセル・見出しの行の削除
 *  - unsafe-part     … 行のずらし方が分からない部品（ピボット等）を持つシートの行の挿入・削除
 */
export type ExcelBlockReason = 'sheet-structure' | 'array-formula' | 'table-header' | 'unsafe-part';

export interface ExcelBlockedTarget {
  readonly row: number;
  /** -1 なら行全体（片側にしか無い行）。 */
  readonly col: number;
  readonly reason: ExcelBlockReason;
}

export interface ExcelConflictTargets {
  /** 両側にある行で値が違うセル（揃えた行, 列 の組の平らな並び）。 */
  readonly cells: readonly number[];
  /** 片側にしか無い揃えた行（行全体で決める）。 */
  readonly rows: readonly number[];
  readonly blocked: readonly ExcelBlockedTarget[];
}

const BLOCK_MESSAGE: Record<ExcelBlockReason, string> = {
  'sheet-structure': 'シートの追加・削除は相手側を採れません。ファイル単位で採用してください。',
  'array-formula': '配列数式・データテーブルに関わる所は相手側を採れません。ファイル単位で採用してください。',
  'table-header': 'テーブルの見出しは相手側を採れません。ファイル単位で採用してください。',
  'unsafe-part': 'このシートは行のずらし方が分からない部品（ピボット等）を持つため、行の挿入・削除はできません。ファイル単位で採用してください。',
};

const isArrayCell = (cell: CellData | undefined): boolean =>
  cell?.formulaKind === FORMULA_ARRAY || cell?.formulaKind === FORMULA_DATA_TABLE;

function cellOf(sheet: SheetComparison, side: 'old' | 'new', row: number, col: number): CellData | undefined {
  if (row < 0) return undefined;
  const data = side === 'old' ? sheet.old?.data : sheet.new?.data;
  return data?.rows[row]?.cells.find((c) => c.col === col);
}

/** 1 シートの「決めるべき所」と「相手側を採れない所」。 */
function targetsOfSheet(view: ExcelComparison, sheet: SheetComparison, isBook: boolean): ExcelConflictTargets {
  const sstOld = view.comparison.old?.sst ?? [];
  const sstNew = view.comparison.new?.sst ?? [];
  const cells: number[] = [];
  const rows: number[] = [];
  const blocked: ExcelBlockedTarget[] = [];
  const paired = sheet.old !== null && sheet.new !== null;
  const insp: SheetInspection | undefined =
    isBook && sheet.old !== null ? view.conflict?.inspection?.get(sheet.old.name.toLowerCase()) : undefined;
  const arrays = insp?.arrayRanges ?? [];
  const headers = insp?.tableHeaders ?? [];

  // 揃えた行ごとの直前・直後の自分側の行（挿入点が配列数式の内側かを見る）
  let lastOurs = -1;
  const nextOurs = new Int32Array(sheet.oldRow.length + 1).fill(-1);
  for (let i = sheet.oldRow.length - 1, next = -1; i >= 0; i -= 1) {
    nextOurs[i] = next;
    const o = sheet.oldRow[i] ?? -1;
    if (o >= 0) next = o;
  }

  for (let i = 0; i < sheet.oldRow.length; i += 1) {
    const o = sheet.oldRow[i] ?? -1;
    const n = sheet.newRow[i] ?? -1;
    const state = sheet.rowState[i] ?? ROW_SAME;
    if (state === ROW_SAME) {
      if (o >= 0) lastOurs = o;
      continue;
    }
    if (o >= 0 && n >= 0 && state === ROW_CHANGED) {
      for (const col of changedColumns(sheet.old?.data?.rows[o]?.cells, sstOld, sheet.new?.data?.rows[n]?.cells, sstNew)) {
        cells.push(i, col);
        if (!isBook) continue;
        if (isArrayCell(cellOf(sheet, 'old', o, col)) || isArrayCell(cellOf(sheet, 'new', n, col)) ||
            arrays.some((a) => o >= a.r1 && o <= a.r2 && col >= a.c1 && col <= a.c2)) {
          blocked.push({ row: i, col, reason: 'array-formula' });
        } else if (headers.some((h) => h.row === o && col >= h.c1 && col <= h.c2)) {
          blocked.push({ row: i, col, reason: 'table-header' });
        }
      }
      lastOurs = o;
      continue;
    }
    // 片側にしか無い行
    rows.push(i);
    if (!isBook) {
      if (o >= 0) lastOurs = o;
      continue;
    }
    if (!paired) {
      blocked.push({ row: i, col: -1, reason: 'sheet-structure' });
    } else if ((insp?.unsafeRelations.length ?? 0) > 0) {
      blocked.push({ row: i, col: -1, reason: 'unsafe-part' });
    } else if (o >= 0 && headers.some((h) => h.row === o)) {
      blocked.push({ row: i, col: -1, reason: 'table-header' });
    } else if (o >= 0 ? arrays.some((a) => o >= a.r1 && o <= a.r2) : arrays.some((a) => lastOurs >= a.r1 && (nextOurs[i] ?? -1) >= 0 && (nextOurs[i] ?? -1) <= a.r2)) {
      blocked.push({ row: i, col: -1, reason: 'array-formula' });
    }
    if (o >= 0) lastOurs = o;
  }
  return { cells, rows, blocked };
}

/**
 * シートごとの「決めるべき所」と「相手側を採れない所」（決定 34）。セル単位で採れない比較・
 * 衝突セルが上限を超えたときは null。renderer が未決定の数・次の未決定・採れない理由を出すのに使う。
 */
export function conflictTargetsOf(view: ExcelComparison): ExcelConflictTargets[] | null {
  const conflict = view.conflict;
  if (conflict?.cellResolvable !== true) return null;
  const isBook = conflict.source === 'stages';
  const out: ExcelConflictTargets[] = [];
  let total = 0;
  for (const sheet of view.comparison.sheets) {
    const t = targetsOfSheet(view, sheet, isBook);
    total += t.cells.length / 2;
    if (total > MAX_CONFLICT_CELLS) return null;
    out.push(t);
  }
  return out;
}

export interface XlsxPlanResult {
  readonly sheets: readonly XlsxSheetMerge[];
  readonly unresolved: number;
  /** 相手側を採れない所で相手側が選ばれていれば、その理由。 */
  readonly blocked: string | null;
}

/**
 * ブックの採り方を、シートごとの行の並びと行の対応にする（docs/07 5.1）。
 *
 * 両側にある行は必ず出す（違う列のうち相手側を採ったものを差し替える）。片側にしか無い行は、
 * その行がある側を採れば出し、無い側を採れば出さない（自分側の行なら削除、相手側の行なら挿入しない）。
 */
export function planXlsxResolution(view: ExcelComparison, choices: ExcelCellChoices): XlsxPlanResult {
  const pick = new Choices(choices);
  const targets = conflictTargetsOf(view);
  const sheets: XlsxSheetMerge[] = [];
  let unresolved = 0;
  let blocked: string | null = null;
  const sstOld = view.comparison.old?.sst ?? [];
  const sstNew = view.comparison.new?.sst ?? [];

  view.comparison.sheets.forEach((sheet, s) => {
    const blockedAt = new Map<string, ExcelBlockReason>();
    for (const b of targets?.[s]?.blocked ?? []) blockedAt.set(`${String(b.row)}:${String(b.col)}`, b.reason);
    const block = (row: number, col: number): void => {
      const reason = blockedAt.get(`${String(row)}:${String(col)}`);
      if (reason !== undefined) blocked ??= BLOCK_MESSAGE[reason];
    };

    if (sheet.old === null || sheet.new === null) {
      for (let i = 0; i < sheet.oldRow.length; i += 1) {
        const side = pick.row(s, i, sheet.old !== null ? 'ours' : 'theirs');
        // 両方を採用するのも、シートを足す・消すことになる
        if (pick.block(s, i) !== null) blocked ??= BLOCK_MESSAGE['sheet-structure'];
        if (side === null) unresolved += 1;
        else if (side === 'theirs') blocked ??= BLOCK_MESSAGE['sheet-structure'];
      }
      return;
    }

    const oursCount = maxOf(sheet.oldRow) + 1;
    const theirsCount = maxOf(sheet.newRow) + 1;
    const oursNewIndex = new Int32Array(oursCount).fill(-1);
    const theirsNewIndex = new Int32Array(theirsCount).fill(-1);
    const rows: OutRow[] = [];
    let changed = false;
    const starts = hunkStartsOf(sheet);
    const insp = view.conflict?.inspection?.get(sheet.old.name.toLowerCase());
    const unsafe = (insp?.unsafeRelations.length ?? 0) > 0;

    /** 両方を採用して出す行（相手側の行は挿入になる）。採れない所を含めば断る。 */
    const emitBoth = (from: number, to: number, order: ExcelBothOrder): void => {
      for (let i = from; i < to; i += 1) {
        if (unsafe) blocked ??= BLOCK_MESSAGE['unsafe-part'];
        for (const key of blockedAt.keys()) if (key.startsWith(`${String(i)}:`)) block(i, Number(key.split(':')[1]));
      }
      for (const r of bothRows(sheet, from, to, order)) {
        // 打った値は自分側の版（無ければ相手側の版）にだけ当てる（docs/07 7.3）
        const hasOurs = (sheet.oldRow[r.aligned] ?? -1) >= 0;
        const typed = r.kind === 'ours' || !hasOurs ? pick.editsInRow(s, r.aligned) : new Map<number, string>();
        if (r.kind === 'ours') {
          oursNewIndex[r.row] = rows.length;
          rows.push({ kind: 'ours', row: r.row, theirsRow: -1, theirsCols: new Set(), edits: typed });
        } else {
          theirsNewIndex[r.row] = rows.length;
          rows.push({ kind: 'theirs', row: r.row, edits: typed });
        }
      }
      changed = true;
    };

    for (let i = 0; i < sheet.oldRow.length; i += 1) {
      const o = sheet.oldRow[i] ?? -1;
      const n = sheet.newRow[i] ?? -1;
      const blk = (starts[i] ?? -1) >= 0 ? pick.block(s, i) : null;
      if (blk !== null) {
        const end = blockEnd(starts, i, blk.end);
        emitBoth(i, end, blk.order);
        i = end - 1;
        continue;
      }
      if (o >= 0 && n >= 0 && (sheet.rowState[i] ?? ROW_SAME) !== ROW_SAME) {
        const rowOrder = pick.rowBoth(s, i);
        if (rowOrder !== null) {
          emitBoth(i, i + 1, rowOrder);
          continue;
        }
      }
      if (o >= 0 && n >= 0) {
        const theirsCols = new Set<number>();
        const edits = new Map<number, string>();
        if ((sheet.rowState[i] ?? ROW_SAME) !== ROW_SAME) {
          for (const col of changedColumns(sheet.old.data?.rows[o]?.cells, sstOld, sheet.new.data?.rows[n]?.cells, sstNew)) {
            const typed = pick.edit(s, i, col);
            if (typed !== undefined) {
              // 打った値も、配列数式・テーブルの見出しには書けない（相手側を採るのと同じ扱い）
              block(i, col);
              edits.set(col, typed);
              continue;
            }
            const side = pick.cell(s, i, col);
            if (side === null) unresolved += 1;
            else if (side === 'theirs') {
              block(i, col);
              theirsCols.add(col);
            }
          }
        }
        // 値の違わないセルに打った値も書く（プレビューでの編集）
        for (const [col, value] of pick.editsInRow(s, i)) if (!edits.has(col)) edits.set(col, value);
        if (theirsCols.size > 0 || edits.size > 0) changed = true;
        oursNewIndex[o] = rows.length;
        theirsNewIndex[n] = rows.length;
        rows.push({ kind: 'ours', row: o, theirsRow: n, theirsCols, edits });
        continue;
      }
      const side = pick.row(s, i, o >= 0 ? 'ours' : 'theirs');
      if (side === null) {
        unresolved += 1;
        // 決まっていない間は自分側のまま並べておく（行の対応を作るため。書き込みは unresolved で止まる）
        if (o >= 0) {
          oursNewIndex[o] = rows.length;
          rows.push({ kind: 'ours', row: o, theirsRow: -1, theirsCols: new Set() });
        }
        continue;
      }
      if (side === 'theirs') block(i, -1);
      if (o >= 0) {
        if (side === 'ours') {
          const typed = pick.editsInRow(s, i);
          if (typed.size > 0) changed = true;
          oursNewIndex[o] = rows.length;
          rows.push({ kind: 'ours', row: o, theirsRow: -1, theirsCols: new Set(), edits: typed });
        } else {
          changed = true;
        }
      } else if (side === 'theirs') {
        theirsNewIndex[n] = rows.length;
        rows.push({ kind: 'theirs', row: n, edits: pick.editsInRow(s, i) });
        changed = true;
      }
    }

    sheets.push({
      oursName: sheet.old.name,
      theirsName: sheet.new.name,
      rows: changed ? rows : null,
      oursNewIndex,
      oursTailShift: rows.length - oursCount,
      theirsNewIndex,
      theirsTailShift: rows.length - theirsCount,
    });
  });
  return { sheets, unresolved, blocked };
}

/**
 * 採用して作業ツリーへ書き戻す。書けたら何も返さない（呼び出し側が比較のキャッシュを捨てる）。
 *
 * 失敗の種類:
 *   - 作業ツリー（ブックなら両側の段も）が比較を作ったときと違う → StaleDiffError（取り直してからやり直す）
 *   - 削除された側の採用・セル単位で採れないファイル・決まっていない違い・相手側を採れない所 → ConflictUnsupportedError
 */
export async function resolveExcelConflict(
  source: ExcelResolveSource,
  view: ExcelComparison,
  request: ExcelResolveRequest,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  const conflict = view.conflict;
  if (conflict === null) throw new ConflictUnsupportedError('このファイルは未マージではありません。');
  const ctx = source.context(signal);
  const path = view.path;

  // 書く直前の照合。比較を作ってから誰か（Excel・エディタ）が書き換えていれば止める
  const fresh = await source.track(['read-worktree', path], async () => {
    try {
      return await readWorktreeBytes(ctx, path, { maxBytes });
    } catch (err) {
      if (err instanceof WorktreeFileLockedError) return 'locked' as const;
      throw err;
    }
  });
  if (worktreeFingerprint(fresh) !== conflict.fingerprint || fresh === 'locked') {
    throw new StaleDiffError(
      '表示中の内容が作業ツリーのファイルと食い違っています。取り直してからやり直してください。',
    );
  }

  const readStage = async (side: ExcelConflictSide): Promise<Uint8Array> => {
    const read = await source.track(['cat-file', (side === 'ours' ? ':2:' : ':3:') + path], () =>
      readBlobFiltered(ctx, side, path, { maxBytes }),
    );
    if (read === null) throw new StaleDiffError();
    if (read.kind !== 'ok') throw new ConflictUnsupportedError('大きすぎるため採用できません（上限 100MB）。');
    return read.bytes;
  };

  let bytes: Uint8Array;
  if (conflict.source === 'markers') {
    if (fresh === null || fresh.kind !== 'ok') throw new StaleDiffError();
    const split = splitCsvConflict(fresh.bytes);
    if (split.kind !== 'split') throw new StaleDiffError();
    if (request.kind === 'file') {
      bytes = request.side === 'ours' ? split.ours : split.theirs;
    } else {
      if (!conflict.cellResolvable) {
        throw new ConflictUnsupportedError('このファイルはセル単位では採用できません。ファイル単位で採用してください。');
      }
      // 打った値は、ファイルの文字コード（UTF-8 / Shift_JIS）で書く
      const encoding = decodeCsv(split.ours)?.encoding ?? null;
      const { plans, unresolved } = planCsvResolution(view, request.choices, (text) =>
        encoding === null ? null : encodeCsvField(text, encoding),
      );
      if (unresolved > 0) throw unresolvedError(unresolved);
      bytes = composeCsv(split.ours, split.theirs, plans);
    }
  } else if (request.kind === 'file') {
    const side = request.side === 'ours' ? view.old : view.new;
    if (side.state === 'absent') {
      throw new ConflictUnsupportedError('この側ではファイルが削除されています。削除は差分モードで行ってください。');
    }
    bytes = await readStage(request.side);
  } else {
    const oursBook = view.old.workbook;
    const theirsBook = view.new.workbook;
    if (!conflict.cellResolvable || oursBook === null || theirsBook === null) {
      throw new ConflictUnsupportedError('このファイルはセル単位では採用できません。ファイル単位で採用してください。');
    }
    const plan = planXlsxResolution(view, request.choices);
    if (plan.unresolved > 0) throw unresolvedError(plan.unresolved);
    if (plan.blocked !== null) throw new ConflictUnsupportedError(plan.blocked);
    // 比較に使った両側（読み取り済みのブック）と、いま index にある両側が同じか
    const ours = await readStage('ours');
    const theirs = await readStage('theirs');
    if (hashOf(ours) !== conflict.stageHashes.ours || hashOf(theirs) !== conflict.stageHashes.theirs) {
      throw new StaleDiffError('index の自分側・相手側が表示中の内容と食い違っています。取り直してからやり直してください。');
    }
    try {
      bytes = mergeXlsx({
        ours,
        theirs,
        oursBook,
        theirsBook,
        sheets: plan.sheets,
        inflate: zlibInflater,
        deflate: zlibDeflater,
      });
    } catch (err) {
      if (err instanceof XlsxMergeError) throw new ConflictUnsupportedError(err.message);
      throw err;
    }
  }

  await source.track(['write-worktree', path], async () => {
    try {
      await writeWorktreeBytes(ctx, path, bytes);
    } catch (err) {
      if (err instanceof WorktreeFileLockedError) {
        throw new ConflictUnsupportedError('他のアプリがファイルを使用中のため書き込めません。閉じてからやり直してください。');
      }
      throw err;
    }
  });
}

/** 配列の最大値（空なら -1）。100 万行あるので展開して Math.max に渡さない。 */
function maxOf(values: Int32Array): number {
  let max = -1;
  for (const v of values) if (v > max) max = v;
  return max;
}

function unresolvedError(count: number): ConflictUnsupportedError {
  return new ConflictUnsupportedError(`まだ決めていない違いが ${String(count)} 件あります。すべて決めてから書き込んでください。`);
}
