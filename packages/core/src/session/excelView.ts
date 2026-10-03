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

import {
  DEFAULT_LIMITS,
  buildGeometry,
  buildRowDiff,
  compareWorkbooksSteps,
  openSpreadsheetSteps,
  type ExcelLimits,
  type RowDiff,
  type SheetGeometry,
  type Workbook,
  type WorkbookComparison,
} from '@feathertree/excel';
import {
  GitCancelledError,
  GitCommandError,
  GitNotFoundError,
  WorktreeFileLockedError,
  readHeadBlobFiltered,
  readWorktreeBytes,
  type BlobBytes,
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

export interface ExcelComparison {
  readonly path: string;
  /** HEAD 側を読んだパス（リネームなら元のパス）。 */
  readonly headPath: string;
  readonly statusSeq: number;
  /** キャッシュの世代。トークンに使う。 */
  readonly gen: number;
  readonly old: ExcelSide;
  readonly new: ExcelSide;
  readonly comparison: WorkbookComparison;
  /** シートの幾何（選ばれたシートのぶんだけ作る）。 */
  readonly geometry: Map<number, SheetGeometry>;
  /** 行単位の比較（文脈行数ごと）。 */
  readonly rowDiff: Map<number, RowDiff>;
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
    };
  }
  const headPath = entry?.kind === 'renamed' && entry.origPath !== undefined ? entry.origPath : path;
  // HEAD に無いと分かっている（未追跡・index で新規）なら #49 を打たない
  const headKnownAbsent = entry?.kind === 'untracked' || entry?.staged === 'A';
  const ctx = source.context(signal);
  const maxBytes = limits.maxFileBytes;

  let oldSide: ExcelSide;
  if (headKnownAbsent) {
    oldSide = { state: 'absent', workbook: null, bytes: 0, detail: null };
  } else {
    try {
      const read = await source.track(['cat-file', headPath], () => readHeadBlobFiltered(ctx, headPath, { maxBytes }));
      oldSide = await openSide(headPath, read, limits, signal);
    } catch (err) {
      // 中止と「git が無い」だけは全体の失敗にする。それ以外（LFS の失敗・タイムアウト）は旧側の案内にして、
      // 新側は見せる（要件 E7「片側が駄目でも、もう片側は見せる」）
      if (err instanceof GitCancelledError || err instanceof GitNotFoundError) throw err;
      if (err instanceof GitCommandError && LFS_FAILURE.test(err.stderr)) {
        oldSide = { state: 'lfs-failed', workbook: null, bytes: 0, detail: err.stderr.trim() };
      } else {
        const detail = err instanceof GitCommandError ? err.stderr.trim() : err instanceof Error ? err.message : String(err);
        oldSide = { state: 'unavailable', workbook: null, bytes: 0, detail };
      }
    }
  }
  throwIfAborted(signal);

  let newSide: ExcelSide;
  try {
    const read = await source.track(['read-worktree', path], () => readWorktreeBytes(ctx, path, { maxBytes }));
    newSide = await openSide(path, read, limits, signal);
  } catch (err) {
    if (err instanceof WorktreeFileLockedError) {
      newSide = { state: 'locked', workbook: null, bytes: 0, detail: err.message };
    } else {
      throw err;
    }
  }
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
  };
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

/** 行単位の比較（差分モードの C 案）。文脈行数ごとに 1 回だけ作る。 */
export function rowDiffOf(view: ExcelComparison, contextLines: number, limits: ExcelLimits = DEFAULT_LIMITS): RowDiff {
  const cached = view.rowDiff.get(contextLines);
  if (cached !== undefined) return cached;
  const diff = buildRowDiff(view.comparison, contextLines, limits);
  view.rowDiff.set(contextLines, diff);
  return diff;
}
