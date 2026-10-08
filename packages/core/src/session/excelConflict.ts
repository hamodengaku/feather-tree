/*
 * Excel 差分モードのコンフリクトの採用（決定 34）。作業ツリーへ書き戻すだけで、index には触れない。
 *
 *   - ファイル単位（ブック・CSV）: 採る側をそのまま書く
 *       - CSV のマーカー方式 … 作業ツリーを読み直し、全ブロックをその側で解いたもの（git は 0）
 *       - 段の方式（ブック）  … 採る側の段を #49 で読み直したもの（1 プロセス）
 *   - セル・行・列単位（CSV のマーカー方式だけ）: 揃えた行・列の座標と側から、行ごとの採り方を決めて継ぎ合わせる
 *
 * renderer から受け取るのは**座標と側だけ**。本文は main が読み直したものから作る（決定 30 の採用・
 * hunk のステージと同じ。決定「やらないこと」のパッチ文字列の項）。書く直前に作業ツリーを読み直し、
 * 比較を作ったときと同じバイト列か指紋で照合する。
 */

import {
  ROW_CHANGED,
  ROW_SAME,
  changedColumns,
  composeCsv,
  splitCsvConflict,
  type CsvRowPlan,
  type SheetComparison,
} from '@feathertree/excel';
import {
  WorktreeFileLockedError,
  readBlobFiltered,
  readWorktreeBytes,
  writeWorktreeBytes,
  type GitContext,
} from '@feathertree/git';
import { ConflictUnsupportedError, StaleDiffError } from './sessionErrors.js';
import { worktreeFingerprint, type ExcelComparison } from './excelView.js';

export type ExcelConflictSide = 'ours' | 'theirs';

/** セル・行・列単位の採り方。優先順位はセル > 行 > 列 > 残りすべて。行・列の番号は揃えた座標。 */
export interface ExcelCellChoices {
  readonly cells: readonly { readonly row: number; readonly col: number; readonly side: ExcelConflictSide }[];
  readonly rows: readonly { readonly row: number; readonly side: ExcelConflictSide }[];
  readonly cols: readonly { readonly col: number; readonly side: ExcelConflictSide }[];
  readonly rest: ExcelConflictSide | null;
}

export type ExcelResolveRequest =
  | { readonly kind: 'file'; readonly side: ExcelConflictSide }
  | { readonly kind: 'cells'; readonly choices: ExcelCellChoices };

/** 書き戻しに要るものだけ。`RepositorySession` がこれを満たす。 */
export interface ExcelResolveSource {
  context(signal?: AbortSignal): GitContext;
  track<T>(args: readonly string[], run: () => Promise<T>): Promise<T>;
}

export interface CsvPlanResult {
  readonly plans: readonly CsvRowPlan[];
  /** 決まっていない違い（セル、または片側にしか無い行）の数。 */
  readonly unresolved: number;
}

/**
 * 揃えた行ごとの採り方を決める（純関数）。
 *
 *   - 両側にある行: 値の違う列ごとに「セル > 行 > 列 > 残り」で側を引く。全部が同じ側なら、その側の
 *     レコードを丸ごと使う（元のバイトのまま）。混ざれば欄を継ぎ合わせる。違いが無ければ自分側
 *   - 片側にしか無い行: 「行 > 残り」で決める（列やセルの指定は効かない。行を入れるか入れないかの話なので）。
 *     その行がある側を採れば入れ、無い側を採れば落とす
 */
export function planCsvResolution(view: ExcelComparison, choices: ExcelCellChoices): CsvPlanResult {
  const sheet = view.comparison.sheets[0];
  if (sheet === undefined || view.comparison.sheets.length !== 1) return { plans: [], unresolved: 0 };
  const cellChoice = new Map<string, ExcelConflictSide>();
  for (const c of choices.cells) cellChoice.set(c.row + ':' + c.col, c.side);
  const rowChoice = new Map<number, ExcelConflictSide>();
  for (const r of choices.rows) rowChoice.set(r.row, r.side);
  const colChoice = new Map<number, ExcelConflictSide>();
  for (const c of choices.cols) colChoice.set(c.col, c.side);

  const oldData = sheet.old?.data ?? null;
  const newData = sheet.new?.data ?? null;
  const sstOld = view.comparison.old?.sst ?? [];
  const sstNew = view.comparison.new?.sst ?? [];

  const plans: CsvRowPlan[] = [];
  let unresolved = 0;
  for (let i = 0; i < sheet.oldRow.length; i += 1) {
    const o = sheet.oldRow[i] ?? -1;
    const n = sheet.newRow[i] ?? -1;
    if (o < 0 || n < 0) {
      const side = rowChoice.get(i) ?? choices.rest;
      if (side === null) {
        unresolved += 1;
        continue;
      }
      if (side === 'ours' && o >= 0) plans.push({ kind: 'ours', row: o });
      if (side === 'theirs' && n >= 0) plans.push({ kind: 'theirs', row: n });
      continue;
    }
    if ((sheet.rowState[i] ?? ROW_SAME) === ROW_SAME) {
      plans.push({ kind: 'ours', row: o });
      continue;
    }
    const changed = changedColumns(oldData?.rows[o]?.cells, sstOld, newData?.rows[n]?.cells, sstNew);
    const theirsCols = new Set<number>();
    let fromOurs = 0;
    let missing = 0;
    for (const col of changed) {
      const side = cellChoice.get(i + ':' + col) ?? rowChoice.get(i) ?? colChoice.get(col) ?? choices.rest;
      if (side === null) missing += 1;
      else if (side === 'theirs') theirsCols.add(col);
      else fromOurs += 1;
    }
    if (missing > 0) {
      unresolved += missing;
      continue;
    }
    if (theirsCols.size === 0) plans.push({ kind: 'ours', row: o });
    else if (fromOurs === 0) plans.push({ kind: 'theirs', row: n });
    else plans.push({ kind: 'mixed', oursRow: o, theirsRow: n, theirsCols });
  }
  return { plans, unresolved };
}

/** 画面に一覧で送る衝突セルの上限。超えたら送らず、行・列・残りすべてで決めてもらう。 */
export const MAX_CONFLICT_CELLS = 200_000;

/**
 * 両側にある行のうち、値が違うセルの一覧（揃えた行, 列 の組を平らに並べたもの）。
 *
 * renderer が「未決定の件数」と「次の未決定へ」をページの取得に頼らずに出すため（決定 34）。
 * セル単位で採れない比較・上限を超えたときは null。
 */
export function conflictCellsOf(view: ExcelComparison, sheet: SheetComparison): number[] | null {
  if (view.conflict?.cellResolvable !== true) return null;
  const oldData = sheet.old?.data ?? null;
  const newData = sheet.new?.data ?? null;
  const sstOld = view.comparison.old?.sst ?? [];
  const sstNew = view.comparison.new?.sst ?? [];
  const out: number[] = [];
  for (const i of sheet.changedRows) {
    if (sheet.rowState[i] !== ROW_CHANGED) continue;
    const o = sheet.oldRow[i] ?? -1;
    const n = sheet.newRow[i] ?? -1;
    for (const col of changedColumns(oldData?.rows[o]?.cells, sstOld, newData?.rows[n]?.cells, sstNew)) {
      if (out.length >= MAX_CONFLICT_CELLS * 2) return null;
      out.push(i, col);
    }
  }
  return out;
}

/**
 * 採用して作業ツリーへ書き戻す。書けたら何も返さない（呼び出し側が比較のキャッシュを捨てる）。
 *
 * 失敗の種類:
 *   - 作業ツリーが比較を作ったときと違う → StaleDiffError（取り直してからやり直す）
 *   - 削除された側の採用・セル単位で採れないファイル・決まっていない違いが残っている → ConflictUnsupportedError
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
      const { plans, unresolved } = planCsvResolution(view, request.choices);
      if (unresolved > 0) {
        throw new ConflictUnsupportedError(
          `まだ決めていない違いが ${String(unresolved)} 件あります。すべて決めてから書き込んでください。`,
        );
      }
      bytes = composeCsv(split.ours, split.theirs, plans);
    }
  } else {
    if (request.kind !== 'file') {
      throw new ConflictUnsupportedError('このファイルはセル単位では採用できません。ファイル単位で採用してください。');
    }
    const side = request.side === 'ours' ? view.old : view.new;
    if (side.state === 'absent') {
      throw new ConflictUnsupportedError('この側ではファイルが削除されています。削除は差分モードで行ってください。');
    }
    const read = await source.track(['cat-file', (request.side === 'ours' ? ':2:' : ':3:') + path], () =>
      readBlobFiltered(ctx, request.side, path, { maxBytes }),
    );
    if (read === null) throw new StaleDiffError();
    if (read.kind !== 'ok') throw new ConflictUnsupportedError('大きすぎるため採用できません（上限 100MB）。');
    bytes = read.bytes;
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
