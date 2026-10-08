/*
 * Excel 差分の「1 ファイルぶんの比較」を組み立てる（決定 33）。
 *
 * git 層と excel 層を縫い合わせる唯一の場所で、次の順に進む。
 *
 *   1. status のスナップショットからエントリを引き、HEAD 側のパス（リネームなら元のパス）と
 *      「HEAD に無いと分かっているか」（未追跡・index で新規）を決める
 *   2. HEAD 側を #49（`cat-file --filters`。LFS の実体）で、作業ツリー側を直接読む
 *   3. それぞれを excel 層で開く（シート 1 枚ごとにイベントループへ譲り、中止を確かめる）
 *   4. 新旧を比べる（これもシート 1 枚ごとに譲る）
 *
 * **片側が駄目でも、もう片側は見せる。** 側ごとの状態（LFS が取れない・パスワード付き・大きすぎる…）を
 * 持たせ、画面はそれを案内に写す（要件 E7）。
 */

import { createHash } from 'node:crypto';
import {
  DEFAULT_LIMITS,
  buildGeometry,
  buildRowDiff,
  cellSideIn,
  compareWorkbooksSteps,
  isCsvPath,
  openSpreadsheetSteps,
  splitCsvConflict,
  type CellSide,
  type ExcelLimits,
  type RowDiff,
  type SheetComparison,
  type SheetGeometry,
  type Workbook,
  type WorkbookComparison,
} from '@feathertree/excel';
import {
  GitCancelledError,
  GitCommandError,
  GitNotFoundError,
  WorktreeFileLockedError,
  readBlobFiltered,
  readWorktreeBytes,
  type BlobBytes,
  type FilteredRevision,
  type GitContext,
  type StatusSnapshot,
} from '@feathertree/git';
import { zlibInflater } from './zlibInflater.js';
import { isOpenableExcelPath } from './excelFiles.js';

/** 側ごとの状態。ok 以外は画面で案内に写す。 */
export type ExcelSideState =
  | 'ok'
  /** その側に無い（新規ファイルの HEAD 側・削除したファイルの作業ツリー側）。 */
  | 'absent'
  /** Git LFS のポインタのまま（作業ツリーで `git lfs pull` をしていない）。 */
  | 'lfs-pointer'
  /** LFS の実体を取り出せない（git-lfs が無い・ダウンロードに失敗した）。 */
  | 'lfs-failed'
  /** HEAD 側を取り出せない（タイムアウトなど、LFS 以外の失敗）。detail に原文。 */
  | 'unavailable'
  /** 旧形式の .xls、またはパスワード付き。 */
  | 'encrypted-or-legacy'
  /** ZIP だがスプレッドシートではない（.xlsb を含む）。 */
  | 'not-spreadsheet'
  | 'not-zip'
  | 'broken'
  | 'too-large'
  /** 作業ツリーのファイルを他のアプリが読ませてくれない。 */
  | 'locked'
  | 'empty';

export interface ExcelSide {
  readonly state: ExcelSideState;
  readonly workbook: Workbook | null;
  /** 読んだバイト数（上限超過のときは大きさ）。 */
  readonly bytes: number;
  /** git の stderr など、案内に添える原文。 */
  readonly detail: string | null;
}

/**
 * 未マージのときの両側の出どころ（決定 34）。
 *  - `markers` … CSV の作業ツリーのマーカーを解いた（git は 0。セル・行・列単位で採れる）
 *  - `stages`  … index の段（`:2:` / `:3:`）を #49 で読んだ（ファイル単位でだけ採れる）
 */
export type ExcelConflictSource = 'markers' | 'stages';

/** 作業ツリーが今どの側と同じか（`stages` のとき）。`markers` では常に `neither`（マーカー入り）。 */
export type ExcelWorktreeMatch = 'ours' | 'theirs' | 'neither' | 'absent' | 'unknown';

/** CSV のマーカーの読め方。`markers` に入れなかった理由の案内に使う。ブックは `not-csv`。 */
export type ExcelMarkerState = 'split' | 'none' | 'malformed' | 'unsupported' | 'not-csv';

export interface ExcelConflict {
  readonly source: ExcelConflictSource;
  readonly markers: ExcelMarkerState;
  /** `markers` のときの衝突ブロックの数。 */
  readonly blocks: number;
  readonly worktree: ExcelWorktreeMatch;
  /** 共通祖先（ブックの `stages` のときだけ読む。値バー用）。 */
  readonly base: ExcelSide | null;
  /** セル・行・列単位で採れるか（`markers` で、両側とも上限内で読めたとき）。 */
  readonly cellResolvable: boolean;
  /**
   * 作業ツリーのバイト列の指紋（無ければ 'absent'、読めなければ 'unknown'）。
   * 採用の直前に読み直したものと照合する（違えば diff-stale）。renderer はこれが同じ間だけ選択を持ち越す。
   */
  readonly fingerprint: string;
}

export interface ExcelComparison {
  readonly path: string;
  /** HEAD 側を読んだパス（リネームなら元のパス）。 */
  readonly headPath: string;
  readonly statusSeq: number;
  /** キャッシュの世代。トークンに使う。 */
  readonly gen: number;
  /** 未マージのときは old = 自分側、new = 相手側（決定 34）。 */
  readonly old: ExcelSide;
  readonly new: ExcelSide;
  readonly comparison: WorkbookComparison;
  /** シートの幾何（選ばれたシートのぶんだけ作る）。 */
  readonly geometry: Map<number, SheetGeometry>;
  /** 行単位の比較（文脈行数ごと）。 */
  readonly rowDiff: Map<number, RowDiff>;
  /** 未マージでなければ null。 */
  readonly conflict: ExcelConflict | null;
}

/** 組み立てに要るものだけ。`RepositorySession` がこれを満たす。 */
export interface ExcelViewSource {
  readonly statusSeq: number;
  readonly snapshot: StatusSnapshot | null;
  context(signal?: AbortSignal): GitContext;
  /** 実行ログに載せるための包み。ここを通らない読み取りがあると「実行ログに出ない git」ができてしまう。 */
  track<T>(args: readonly string[], run: () => Promise<T>): Promise<T>;
}

/** LFS（や他の smudge フィルタ）の失敗の文面。`policy/errorMapping.ts` の LFS 行と揃える。 */
const LFS_FAILURE = /smudge filter|git-lfs|external filter|filter-process|Error downloading object/i;

/** イベントループへ 1 回譲る（シートの間で IPC や描画を止めないため）。 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new GitCancelledError();
}

/** 生成器を最後まで回す。1 段ごとに譲って中止を確かめる。 */
async function drive<T>(steps: Generator<void, T>, signal: AbortSignal | undefined): Promise<T> {
  for (;;) {
    const r = steps.next();
    if (r.done === true) return r.value;
    await yieldToLoop();
    throwIfAborted(signal);
  }
}

async function openSide(
  path: string,
  read: BlobBytes | null,
  limits: ExcelLimits,
  signal: AbortSignal | undefined,
): Promise<ExcelSide> {
  if (read === null) return { state: 'absent', workbook: null, bytes: 0, detail: null };
  if (read.kind === 'too-large') return { state: 'too-large', workbook: null, bytes: read.bytes, detail: null };
  const bytes = new Uint8Array(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength);
  // ブックは ZIP として、CSV はテキストとして開く（どちらも同じモデルに載る）
  const opened = await drive(openSpreadsheetSteps(path, bytes, zlibInflater, limits), signal);
  if (!opened.ok) return { state: opened.reason, workbook: null, bytes: bytes.length, detail: null };
  return { state: 'ok', workbook: opened.workbook, bytes: bytes.length, detail: null };
}

export async function buildExcelComparison(
  source: ExcelViewSource,
  path: string,
  gen: number,
  signal?: AbortSignal,
  limits: ExcelLimits = DEFAULT_LIMITS,
): Promise<ExcelComparison> {
  const statusSeq = source.statusSeq;
  const entry = source.snapshot?.entries.find((e) => e.path === path);

  // 開けない形式（.xls / .xlsb）は git を起動せずに案内だけを返す（決定 33「一覧に出すが案内のみ。git は 0」）
  if (!isOpenableExcelPath(path)) {
    const state: ExcelSideState = path.toLowerCase().endsWith('.xlsb') ? 'not-spreadsheet' : 'encrypted-or-legacy';
    const side = (present: boolean): ExcelSide => ({ state: present ? state : 'absent', workbook: null, bytes: 0, detail: null });
    const oldPresent = !(entry?.kind === 'untracked' || entry?.staged === 'A');
    const newPresent = entry?.worktree !== 'D';
    return {
      path,
      headPath: path,
      statusSeq,
      gen,
      old: side(oldPresent),
      new: side(newPresent),
      comparison: await drive(compareWorkbooksSteps(null, null, limits), signal),
      geometry: new Map(),
      rowDiff: new Map(),
      conflict: null,
    };
  }
  if (entry?.kind === 'unmerged') return buildConflictComparison(source, path, gen, signal, limits);

  const headPath = entry?.kind === 'renamed' && entry.origPath !== undefined ? entry.origPath : path;
  // HEAD に無いと分かっている（未追跡・index で新規）なら #49 を打たない
  const headKnownAbsent = entry?.kind === 'untracked' || entry?.staged === 'A';
  const ctx = source.context(signal);

  const oldSide = headKnownAbsent
    ? ABSENT
    : (await readGitSide(source, ctx, 'HEAD', headPath, limits, signal)).side;
  throwIfAborted(signal);

  const newSide = (await readWorktreeSide(source, ctx, path, limits, signal)).side;
  throwIfAborted(signal);

  const comparison = await drive(compareWorkbooksSteps(oldSide.workbook, newSide.workbook, limits), signal);
  return {
    path,
    headPath,
    statusSeq,
    gen,
    old: oldSide,
    new: newSide,
    comparison,
    geometry: new Map(),
    rowDiff: new Map(),
    conflict: null,
  };
}

const ABSENT: ExcelSide = { state: 'absent', workbook: null, bytes: 0, detail: null };

/** 読んだ側と、照合に使う元のバイト列（上限超過・無い・読めないなら null）。 */
interface ReadSide {
  readonly side: ExcelSide;
  readonly raw: Uint8Array | null;
}

/**
 * #49 で 1 つの版（HEAD か index の段）を読んで開く。
 *
 * 中止と「git が無い」だけは全体の失敗にする。それ以外（LFS の失敗・タイムアウト）はその側の案内にして、
 * もう片側は見せる（要件 E7「片側が駄目でも、もう片側は見せる」）。
 */
async function readGitSide(
  source: ExcelViewSource,
  ctx: GitContext,
  revision: FilteredRevision,
  path: string,
  limits: ExcelLimits,
  signal: AbortSignal | undefined,
): Promise<ReadSide> {
  try {
    const read = await source.track(['cat-file', SPEC_LABEL[revision] + path], () =>
      readBlobFiltered(ctx, revision, path, { maxBytes: limits.maxFileBytes }),
    );
    return { side: await openSide(path, read, limits, signal), raw: read?.kind === 'ok' ? read.bytes : null };
  } catch (err) {
    if (err instanceof GitCancelledError || err instanceof GitNotFoundError) throw err;
    if (err instanceof GitCommandError && LFS_FAILURE.test(err.stderr)) {
      return { side: { state: 'lfs-failed', workbook: null, bytes: 0, detail: err.stderr.trim() }, raw: null };
    }
    const detail = err instanceof GitCommandError ? err.stderr.trim() : err instanceof Error ? err.message : String(err);
    return { side: { state: 'unavailable', workbook: null, bytes: 0, detail }, raw: null };
  }
}

/** 実行ログに出すトークンの頭（#49 の引数と同じ形）。 */
const SPEC_LABEL: Record<FilteredRevision, string> = { HEAD: 'HEAD:', base: ':1:', ours: ':2:', theirs: ':3:' };

/** 作業ツリーを読んで開く（git は 0）。他のアプリが掴んでいれば locked。 */
async function readWorktreeSide(
  source: ExcelViewSource,
  ctx: GitContext,
  path: string,
  limits: ExcelLimits,
  signal: AbortSignal | undefined,
): Promise<ReadSide & { readonly read: BlobBytes | null | 'locked' }> {
  try {
    const read = await source.track(['read-worktree', path], () =>
      readWorktreeBytes(ctx, path, { maxBytes: limits.maxFileBytes }),
    );
    return { side: await openSide(path, read, limits, signal), raw: read?.kind === 'ok' ? read.bytes : null, read };
  } catch (err) {
    if (err instanceof WorktreeFileLockedError) {
      return { side: { state: 'locked', workbook: null, bytes: 0, detail: err.message }, raw: null, read: 'locked' };
    }
    throw err;
  }
}

/** 作業ツリーの指紋。無ければ 'absent'、大きすぎる・読めなければ 'unknown'。 */
export function worktreeFingerprint(read: BlobBytes | null | 'locked'): string {
  if (read === null) return 'absent';
  if (read === 'locked' || read.kind !== 'ok') return 'unknown';
  return createHash('sha1').update(read.bytes).digest('hex');
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  return a !== null && b !== null && Buffer.compare(a, b) === 0;
}

/**
 * 未マージのファイルの比較（決定 34）。old = 自分側、new = 相手側。
 *
 * CSV で作業ツリーのマーカーが読めれば、それを解いて両側を作る（git は 0）。マーカーの外は git の 3-way
 * マージの結果なので、違いとして出るのは本当に衝突した所だけになる。それ以外（ブック・マーカーが無い／壊れた
 * CSV）は index の段を #49 で読み、ブックなら共通祖先（`:1:`）も値バー用に読む。
 */
async function buildConflictComparison(
  source: ExcelViewSource,
  path: string,
  gen: number,
  signal: AbortSignal | undefined,
  limits: ExcelLimits,
): Promise<ExcelComparison> {
  const statusSeq = source.statusSeq;
  const ctx = source.context(signal);
  const csv = isCsvPath(path);

  const worktree = await readWorktreeSide(source, ctx, path, limits, signal);
  throwIfAborted(signal);
  const fingerprint = worktreeFingerprint(worktree.read);

  let markers: ExcelMarkerState = csv ? 'none' : 'not-csv';
  if (csv && worktree.raw !== null) {
    const split = splitCsvConflict(worktree.raw);
    markers = split.kind;
    if (split.kind === 'split') {
      const oldSide = await openSide(path, { kind: 'ok', bytes: Buffer.from(split.ours) }, limits, signal);
      const newSide = await openSide(path, { kind: 'ok', bytes: Buffer.from(split.theirs) }, limits, signal);
      const comparison = await drive(compareWorkbooksSteps(oldSide.workbook, newSide.workbook, limits), signal);
      return {
        path,
        headPath: path,
        statusSeq,
        gen,
        old: oldSide,
        new: newSide,
        comparison,
        geometry: new Map(),
        rowDiff: new Map(),
        conflict: {
          source: 'markers',
          markers,
          blocks: split.blocks,
          worktree: 'neither',
          base: null,
          cellResolvable: oldSide.state === 'ok' && newSide.state === 'ok' && sheetsComplete(comparison),
          fingerprint,
        },
      };
    }
  }

  const ours = await readGitSide(source, ctx, 'ours', path, limits, signal);
  throwIfAborted(signal);
  const theirs = await readGitSide(source, ctx, 'theirs', path, limits, signal);
  throwIfAborted(signal);
  // 共通祖先は値バーにだけ出す。CSV は行の対応がずれやすく、同じ番地の値が手掛かりにならないので読まない
  const base = csv ? null : (await readGitSide(source, ctx, 'base', path, limits, signal)).side;
  throwIfAborted(signal);

  let match: ExcelWorktreeMatch;
  if (worktree.read === null) match = 'absent';
  else if (worktree.raw === null) match = 'unknown';
  else if (sameBytes(worktree.raw, ours.raw)) match = 'ours';
  else if (sameBytes(worktree.raw, theirs.raw)) match = 'theirs';
  else match = 'neither';

  const comparison = await drive(compareWorkbooksSteps(ours.side.workbook, theirs.side.workbook, limits), signal);
  return {
    path,
    headPath: path,
    statusSeq,
    gen,
    old: ours.side,
    new: theirs.side,
    comparison,
    geometry: new Map(),
    rowDiff: new Map(),
    conflict: { source: 'stages', markers, blocks: 0, worktree: match, base, cellResolvable: false, fingerprint },
  };
}

/** どのシートも上限で途中までになっていない（セル単位で書き戻すと、読まなかった所が消えるため）。 */
function sheetsComplete(comparison: WorkbookComparison): boolean {
  return comparison.sheets.every(
    (s) =>
      s.old?.problem == null &&
      s.new?.problem == null &&
      s.old?.data?.columnsTruncated !== true &&
      s.new?.data?.columnsTruncated !== true,
  );
}

/** トークン（古いキャッシュを検出するための鍵）。 */
export function excelToken(view: ExcelComparison): string {
  return String(view.statusSeq) + ':' + String(view.gen);
}

/** シートの幾何。初めて求められたときに作る。シートが無ければ null。 */
export function geometryOf(view: ExcelComparison, sheetIndex: number): SheetGeometry | null {
  const cached = view.geometry.get(sheetIndex);
  if (cached !== undefined) return cached;
  const sheet = view.comparison.sheets[sheetIndex];
  if (sheet === undefined) return null;
  const geometry = buildGeometry(sheet);
  view.geometry.set(sheetIndex, geometry);
  return geometry;
}

/**
 * 共通祖先の同じ番地のセル（決定 34。値バー用）。共通祖先を読んでいなければ null。
 *
 * **行の対応付けはしない。** 自分側（無ければ相手側）の行番号・同じ名前のシートのセルを引くだけなので、
 * 行の挿入があると別の行を指しうる（画面にもそう出す）。
 */
export function baseCellOf(view: ExcelComparison, sheet: SheetComparison, alignedRow: number, col: number): CellSide | null {
  const base = view.conflict?.base?.workbook ?? null;
  if (base === null) return null;
  const name = sheet.old?.name ?? sheet.new?.name ?? null;
  const baseSheet = base.sheets.find((s) => s.name === name) ?? null;
  const o = sheet.oldRow[alignedRow] ?? -1;
  const row = o >= 0 ? o : (sheet.newRow[alignedRow] ?? -1);
  if (baseSheet === null || row < 0) return null;
  return cellSideIn(base, baseSheet.data, row, col);
}

/** 行単位の比較（差分モードの C 案）。文脈行数ごとに 1 回だけ作る。 */
export function rowDiffOf(view: ExcelComparison, contextLines: number, limits: ExcelLimits = DEFAULT_LIMITS): RowDiff {
  const cached = view.rowDiff.get(contextLines);
  if (cached !== undefined) return cached;
  const diff = buildRowDiff(view.comparison, contextLines, limits);
  view.rowDiff.set(contextLines, diff);
  return diff;
}
