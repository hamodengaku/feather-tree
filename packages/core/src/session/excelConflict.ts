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
  ROW_CHANGED,
  ROW_SAME,
  XlsxMergeError,
  changedColumns,
  composeCsv,
  decodeCsv,
  encodeCsvField,
  isArrayFormulaCell,
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
  revisionSpec,
  writeWorktreeBytes,
  type GitContext,
} from '@feathertree/git';
import {
  SheetRules,
  blockedChoicesOf,
  choiceMapsOf,
  planSheet,
  type BlockReason,
  type BlockedTarget,
  type BothOrder,
  type ConflictChoices,
  type ConflictSide,
  type ConflictTargets,
} from '@feathertree/conflict-plan';
import { ConflictUnsupportedError, StaleDiffError } from './sessionErrors.js';
import { hashOf, worktreeFingerprint, type ExcelComparison } from './excelView.js';
import { zlibDeflater, zlibInflater } from './zlibInflater.js';

/*
 * 採り方の型と規則は @feathertree/conflict-plan（renderer のプレビュー・未決定の数と同じもの）。
 * ここでは core の名前で別名にして、main・テストの参照を保つ。
 */
export type ExcelConflictSide = ConflictSide;

/** 両方を採用するときの並び（git の ours → theirs / theirs → ours）。docs/07 7.2。 */
export type ExcelBothOrder = BothOrder;

/**
 * セル・行・列単位の採り方。sheet は比較の中のシートの添字、行・列は揃えた座標。rest はブック全体に効く。
 * 優先順位は 両方を採用 > 打った値 > セル > 行 > 列 > 残りすべて（conflict-plan の SheetRules）。
 */
export type ExcelCellChoices = ConflictChoices;

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

const NO_COLS: ReadonlySet<number> = new Set();

/** シートごとの採り方の規則。セル単位で採れない・衝突セルが上限を超えた比較では断る。 */
function rulesOf(view: ExcelComparison, choices: ExcelCellChoices): SheetRules[] {
  const targets = conflictTargetsOf(view);
  if (targets === null) {
    throw new ConflictUnsupportedError('違いが多すぎるため、セル単位では採用できません。ファイル単位で採用してください。');
  }
  const maps = choiceMapsOf(choices);
  return targets.map((t, s) => new SheetRules(s, t, maps));
}

/**
 * CSV の採り方を、出すレコードの並びにする（純関数）。シートは 1 枚（添字 0）。行の並びは planSheet（docs/07 7.2・7.3）。
 *
 *   - 両側にある値の違う行: 値の違う列が全部同じ側なら、その側のレコードを丸ごと使う（元のバイトのまま）。
 *     混ざれば欄を継ぎ合わせる。打った値はその欄を差し替える
 *   - それ以外の行（違いの無い行・両方を採用の版・採った片側だけの行）: その側のレコード。打った値があれば欄を差し替える
 */
export function planCsvResolution(
  view: ExcelComparison,
  choices: ExcelCellChoices,
  /** 打った値を欄にする（引用符と文字コード）。書けなければ null。 */
  encodeField: (text: string) => Uint8Array | null = () => null,
): CsvPlanResult {
  const sheet = view.comparison.sheets[0];
  const rules = rulesOf(view, choices)[0];
  if (sheet === undefined || rules === undefined || view.comparison.sheets.length !== 1) return { plans: [], unresolved: 0 };
  const plan = planSheet(rules, sheet);

  const encodeAll = (values: ReadonlyMap<number, string>): Map<number, Uint8Array> => {
    const out = new Map<number, Uint8Array>();
    for (const [col, text] of values) {
      const field = encodeField(text);
      if (field === null) throw new ConflictUnsupportedError('打った値に、このファイルの文字コードで書けない文字があります。');
      out.set(col, field);
    }
    return out;
  };

  const plans: CsvRowPlan[] = [];
  for (const r of plan.rows) {
    if (r.kind === 'undecided') continue;
    if (r.kind === 'cells') {
      if (r.undecidedCols.size > 0) continue;
      const edits = encodeAll(r.edits);
      if (edits.size > 0) plans.push({ kind: 'mixed', oursRow: r.row, theirsRow: r.theirsRow, theirsCols: r.theirsCols, edits });
      else if (r.theirsCols.size === 0) plans.push({ kind: 'ours', row: r.row });
      else if (r.wholeTheirs) plans.push({ kind: 'theirs', row: r.theirsRow });
      else plans.push({ kind: 'mixed', oursRow: r.row, theirsRow: r.theirsRow, theirsCols: r.theirsCols });
      continue;
    }
    if (r.edits.size === 0) {
      plans.push({ kind: r.side, row: r.row });
      continue;
    }
    const edits = encodeAll(r.edits);
    plans.push(
      r.side === 'ours'
        ? { kind: 'mixed', oursRow: r.row, theirsRow: -1, theirsCols: NO_COLS, edits }
        : { kind: 'mixed', oursRow: -1, theirsRow: r.row, theirsCols: NO_COLS, edits },
    );
  }
  return { plans, unresolved: plan.unresolved };
}

/** 画面に一覧で送る衝突セルの上限（ブック全体）。超えたら送らず、ファイル単位で採ってもらう。 */
export const MAX_CONFLICT_CELLS = 200_000;

export type ExcelBlockReason = BlockReason;
export type ExcelBlockedTarget = BlockedTarget;

/** 1 シートの「決めるべき所」と「相手側を採れない所」（conflict-plan の ConflictTargets）。 */
export type ExcelConflictTargets = ConflictTargets & { readonly bothBlocked: BlockReason | null };

const BLOCK_MESSAGE: Record<ExcelBlockReason, string> = {
  'sheet-structure': 'シートの追加・削除は相手側を採れません。ファイル単位で採用してください。',
  'array-formula': '配列数式・データテーブルに関わる所は相手側を採れません。ファイル単位で採用してください。',
  'table-header': 'テーブルの見出しは相手側を採れません。ファイル単位で採用してください。',
  'unsafe-part': 'このシートは行のずらし方が分からない部品（ピボット等）を持つため、行の挿入・削除はできません。ファイル単位で採用してください。',
};

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
  const unsafe = (insp?.unsafeRelations.length ?? 0) > 0;

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
        if (isArrayFormulaCell(cellOf(sheet, 'old', o, col)) || isArrayFormulaCell(cellOf(sheet, 'new', n, col)) ||
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
    } else if (unsafe) {
      blocked.push({ row: i, col: -1, reason: 'unsafe-part' });
    } else if (o >= 0 && headers.some((h) => h.row === o)) {
      blocked.push({ row: i, col: -1, reason: 'table-header' });
    } else if (o >= 0 ? arrays.some((a) => o >= a.r1 && o <= a.r2) : arrays.some((a) => lastOurs >= a.r1 && (nextOurs[i] ?? -1) >= 0 && (nextOurs[i] ?? -1) <= a.r2)) {
      blocked.push({ row: i, col: -1, reason: 'array-formula' });
    }
    if (o >= 0) lastOurs = o;
  }
  // 両方を採用は相手側の行の挿入になる。シートの追加・削除、行のずらし方が分からないシートでは採れない
  const bothBlocked: BlockReason | null = !isBook ? null : !paired ? 'sheet-structure' : unsafe ? 'unsafe-part' : null;
  return { cells, rows, blocked, bothBlocked };
}

const targetsCache = new WeakMap<ExcelComparison, ExcelConflictTargets[] | null>();

/**
 * シートごとの「決めるべき所」と「相手側を採れない所」（決定 34）。セル単位で採れない比較・
 * 衝突セルが上限を超えたときは null。renderer が未決定の数・採れない理由を出すのにも使う。比較ごとに 1 回だけ作る。
 */
export function conflictTargetsOf(view: ExcelComparison): ExcelConflictTargets[] | null {
  if (targetsCache.has(view)) return targetsCache.get(view) ?? null;
  const out = buildTargets(view);
  targetsCache.set(view, out);
  return out;
}

function buildTargets(view: ExcelComparison): ExcelConflictTargets[] | null {
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
  /** 相手側を採れない所で相手側（打った値・両方を採用）が選ばれていれば、その理由。 */
  readonly blocked: string | null;
}

/**
 * ブックの採り方を、シートごとの行の並びと行の対応にする（docs/07 5.1）。行の並びは planSheet。
 *
 * 両側にある行は必ず出す（違う列のうち相手側を採ったものを差し替える）。片側にしか無い行は、
 * その行がある側を採れば出し、無い側を採れば出さない（自分側の行なら削除、相手側の行なら挿入しない）。
 */
export function planXlsxResolution(view: ExcelComparison, choices: ExcelCellChoices): XlsxPlanResult {
  const rules = rulesOf(view, choices);
  const first = blockedChoicesOf(rules).first;
  const sheets: XlsxSheetMerge[] = [];
  let unresolved = 0;

  view.comparison.sheets.forEach((sheet, s) => {
    const sheetRules = rules[s];
    if (sheetRules === undefined) return;
    if (sheet.old === null || sheet.new === null) {
      // 片側にしか無いシートは自分側のまま（相手側・両方を採用は採れない所として上で断る）
      unresolved += sheetRules.unresolved();
      return;
    }
    const plan = planSheet(sheetRules, sheet);
    unresolved += plan.unresolved;

    const oursCount = maxOf(sheet.oldRow) + 1;
    const theirsCount = maxOf(sheet.newRow) + 1;
    const oursNewIndex = new Int32Array(oursCount).fill(-1);
    const theirsNewIndex = new Int32Array(theirsCount).fill(-1);
    const rows: OutRow[] = [];
    for (const p of plan.rows) {
      const at = rows.length;
      if (p.kind === 'undecided') {
        // 決まっていない間は自分側のまま並べておく（行の対応を作るため。書き込みは unresolved で止まる）
        if (p.side === 'ours') {
          oursNewIndex[p.row] = at;
          rows.push({ kind: 'ours', row: p.row, theirsRow: -1, theirsCols: NO_COLS });
        }
        continue;
      }
      if (p.side === 'theirs') {
        theirsNewIndex[p.row] = at;
        rows.push({ kind: 'theirs', row: p.row, edits: p.edits });
        continue;
      }
      oursNewIndex[p.row] = at;
      if (p.theirsRow >= 0) theirsNewIndex[p.theirsRow] = at;
      rows.push({ kind: 'ours', row: p.row, theirsRow: p.theirsRow, theirsCols: p.theirsCols, edits: p.edits });
    }

    sheets.push({
      oursName: sheet.old.name,
      theirsName: sheet.new.name,
      rows: plan.touched ? rows : null,
      oursNewIndex,
      oursTailShift: rows.length - oursCount,
      theirsNewIndex,
      theirsTailShift: rows.length - theirsCount,
    });
  });
  return { sheets, unresolved, blocked: first === null ? null : BLOCK_MESSAGE[first.reason] };
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
    const read = await source.track(['cat-file', revisionSpec(side) + path], () =>
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
