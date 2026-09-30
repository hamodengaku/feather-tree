/*
 * Excel 差分モード（決定 33）の renderer の状態。`AppState` が `app.excel` として 1 つ持つ。
 *
 * appState.svelte.ts は既に大きいので分けてある。git には触れず、main の 5 チャネル
 * （excel:listFiles / getView / getSheet / getRows / getCell）を呼ぶだけ（差分モードの getRowDiff は appState 側）。
 *
 * **古い応答を捨てる**（要件 E6）: 一覧・ビュー・シート・セルの 4 系統それぞれに世代番号を持ち、
 * 最後に投げた要求の応答だけを採る。main のキャッシュが作り直されていれば `diff-stale` が返るので、
 * ビューから取り直す。
 */

import type {
  ExcelCellDetailDto,
  ExcelFileEntryDto,
  ExcelRowDto,
  ExcelSheetLayoutDto,
  ExcelViewDto,
  FeatherTreeBridge,
  FtErrorDto,
} from '@feathertree/ipc';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { nextChangedRow, pagesFor, ROW_PAGE } from './excelGrid.js';

export interface ExcelSelection {
  /** 揃えた行の添字。 */
  readonly row: number;
  readonly col: number;
}

/** グリッドに「この位置が見えるようにスクロールして」と頼む。seq が変わるたびに 1 回だけ効く。 */
export interface ExcelScrollRequest {
  readonly row: number;
  readonly col: number | null;
  readonly seq: number;
}

interface LoadViewOptions {
  /** 同じシート（添字と名前が同じもの）が残っていればそれを選び続ける（更新のとき）。 */
  readonly keepSheet?: boolean;
}

export class ExcelState {
  readonly #ft: FeatherTreeBridge;
  readonly #activeId: () => string | null;
  readonly #logError: (error: FtErrorDto, sessionId: string) => void;

  constructor(
    bridge: FeatherTreeBridge,
    activeId: () => string | null,
    logError: (error: FtErrorDto, sessionId: string) => void,
  ) {
    this.#ft = bridge;
    this.#activeId = activeId;
    this.#logError = logError;
  }

  files = $state<readonly ExcelFileEntryDto[]>([]);
  filesTruncated = $state(false);
  /** 一覧を一度でも取ったか（0 件は普通の状態なので件数では判定しない）。 */
  filesLoaded = $state(false);
  filesLoading = $state(false);

  selectedPath = $state<string | null>(null);
  view = $state<ExcelViewDto | null>(null);
  viewLoading = $state(false);
  error = $state<FtErrorDto | null>(null);

  /** 選んでいるシート（ExcelViewDto.sheets の index）。 */
  sheet = $state<number | null>(null);
  layout = $state<ExcelSheetLayoutDto | null>(null);
  layoutLoading = $state(false);
  /** 取得済みの行（揃えた行の添字 → 行）。ページ単位で埋まる。 */
  readonly rows = new SvelteMap<number, ExcelRowDto>();

  selection = $state<ExcelSelection | null>(null);
  cell = $state<ExcelCellDetailDto | null>(null);
  /** 非表示の行・列も出すか。 */
  showHidden = $state(false);
  scrollRequest = $state<ExcelScrollRequest | null>(null);

  #listSeq = 0;
  #viewSeq = 0;
  #sheetSeq = 0;
  #cellSeq = 0;
  #scrollSeq = 0;
  /** 取りに行っている最中のページ（重複して要求しない）。描画には使わないが、.svelte.ts では素の Set を持てない。 */
  readonly #inflight = new SvelteSet<number>();

  /** Excel 差分モードのペインから呼ぶ。まだ無いものだけを取りに行く。 */
  async ensure(): Promise<void> {
    if (this.#activeId() === null) return;
    if (!this.filesLoaded && !this.filesLoading) await this.loadFiles();
    const path = this.selectedPath;
    if (path !== null && !this.viewLoading && this.view?.path !== path) await this.loadView(path);
  }

  /** 一覧の取り直し。選んでいたファイルが一覧から消えたら、最初に開けるファイルを選び直す。 */
  async loadFiles(): Promise<void> {
    const id = this.#activeId();
    if (id === null) return;
    const seq = (this.#listSeq += 1);
    this.filesLoading = true;
    try {
      const result = await this.#ft.excelListFiles(id);
      if (seq !== this.#listSeq || id !== this.#activeId()) return;
      if (!result.ok) {
        this.error = result.error;
        this.#logError(result.error, id);
        return;
      }
      this.files = result.value.entries;
      this.filesTruncated = result.value.truncated;
      this.filesLoaded = true;
      const current = this.selectedPath;
      if (current === null || !this.files.some((f) => f.path === current)) {
        // 自動で選ぶのは開けるファイルだけ（.xls を勝手に選んで案内だけを出さない）
        const first = this.files.find((f) => f.openable) ?? null;
        this.#setSelectedPath(first?.path ?? null);
      }
    } finally {
      if (seq === this.#listSeq) this.filesLoading = false;
    }
  }

  /** 一覧でファイルを選ぶ。今出しているファイルなら取り直さない。 */
  async select(path: string): Promise<void> {
    if (path === this.selectedPath && (this.view?.path === path || this.viewLoading)) return;
    this.#setSelectedPath(path);
    await this.loadView(path);
  }

  /**
   * モードに入る前にファイルを決めておく（差分モードで Excel を選んでいた・「Excel モードで開く」）。
   * 取りに行くのはペインの ensure()。
   */
  preselect(path: string): void {
    if (path === this.selectedPath) return;
    this.#setSelectedPath(path);
  }

  async loadView(path: string, options: LoadViewOptions = {}): Promise<void> {
    const id = this.#activeId();
    if (id === null) return;
    const seq = (this.#viewSeq += 1);
    const previous = this.view;
    const previousSheet = this.sheet;
    this.viewLoading = true;
    try {
      const result = await this.#ft.excelGetView(id, path);
      if (seq !== this.#viewSeq || id !== this.#activeId()) return;
      if (!result.ok) {
        // 選び直しで止められた要求（cancelled）は、利用者に見せる失敗ではない
        if (result.error.kind === 'cancelled') return;
        this.#clearView();
        this.error = result.error;
        this.#logError(result.error, id);
        return;
      }
      const view = result.value;
      this.view = view;
      this.error = null;

      let sheet: number | null = null;
      if (options.keepSheet === true && previous !== null && previousSheet !== null) {
        const before = previous.sheets[previousSheet];
        const same = view.sheets.find(
          (s) => s.index === previousSheet && s.newName === before?.newName && s.oldName === before?.oldName,
        );
        if (same !== undefined) sheet = same.index;
      }
      sheet ??= (view.sheets.find((s) => s.mark !== 'same') ?? view.sheets[0])?.index ?? null;
      if (sheet === null) {
        this.#clearSheet();
        return;
      }
      await this.#loadSheet(sheet, options.keepSheet === true && sheet === previousSheet);
    } finally {
      if (seq === this.#viewSeq) this.viewLoading = false;
    }
  }

  async selectSheet(index: number): Promise<void> {
    if (index === this.sheet && this.layout !== null) return;
    await this.#loadSheet(index, false);
  }

  /**
   * シートの幾何を取る。`keepSelection` なら選んでいたセルとスクロールを保つ（更新のとき）。
   * そうでなければ最初の変更を選び、そこへスクロールする。
   */
  async #loadSheet(index: number, keepSelection: boolean): Promise<void> {
    const id = this.#activeId();
    const view = this.view;
    if (id === null || view === null) return;
    const seq = (this.#sheetSeq += 1);
    const keep = keepSelection ? this.selection : null;
    this.sheet = index;
    this.rows.clear();
    this.#inflight.clear();
    if (!keepSelection) {
      this.selection = null;
      this.cell = null;
    }
    this.layoutLoading = true;
    try {
      const result = await this.#ft.excelGetSheet(id, view.token, index);
      if (seq !== this.#sheetSeq || id !== this.#activeId()) return;
      if (!result.ok) {
        await this.#handleFailure(result.error, id);
        return;
      }
      const layout = result.value;
      this.layout = layout;
      if (keep !== null && keep.row < layout.rowCount && keep.col < Math.max(1, layout.colCount)) {
        await this.selectCell(keep.row, keep.col);
        return;
      }
      const first = layout.changedRows[0];
      if (first !== undefined) {
        // 最初の変更行の、最初に変わった列を選ぶ（列は行ページを取らないと分からない）
        await this.#fetchPage(Math.floor(first / ROW_PAGE));
        if (seq !== this.#sheetSeq) return;
        const col = this.rows.get(first)?.changedCols[0] ?? 0;
        await this.selectCell(first, col);
        this.#requestScroll(first, col);
      } else {
        this.selection = null;
        this.cell = null;
        this.#requestScroll(0, 0);
      }
    } finally {
      if (seq === this.#sheetSeq) this.layoutLoading = false;
    }
  }

  /** 揃えた行 [start, end) が見えるようになった。取っていないページを取りに行く。 */
  ensureRows(start: number, end: number): void {
    const layout = this.layout;
    if (layout === null) return;
    for (const page of pagesFor(Math.max(0, start), Math.min(layout.rowCount, end))) {
      if (this.#inflight.has(page) || this.rows.has(page * ROW_PAGE)) continue;
      void this.#fetchPage(page);
    }
  }

  async #fetchPage(page: number): Promise<void> {
    const id = this.#activeId();
    const view = this.view;
    const sheet = this.sheet;
    if (id === null || view === null || sheet === null) return;
    const sheetSeq = this.#sheetSeq;
    this.#inflight.add(page);
    try {
      const result = await this.#ft.excelGetRows(id, view.token, sheet, page * ROW_PAGE, ROW_PAGE);
      if (sheetSeq !== this.#sheetSeq || id !== this.#activeId()) return;
      if (!result.ok) {
        await this.#handleFailure(result.error, id);
        return;
      }
      result.value.rows.forEach((row, i) => this.rows.set(result.value.start + i, row));
    } finally {
      if (sheetSeq === this.#sheetSeq) this.#inflight.delete(page);
    }
  }

  /** セルを選ぶ。値バーの中身（旧値・新値・数式）を取りに行く。 */
  async selectCell(row: number, col: number): Promise<void> {
    const id = this.#activeId();
    const view = this.view;
    const sheet = this.sheet;
    if (id === null || view === null || sheet === null) return;
    this.selection = { row, col };
    const seq = (this.#cellSeq += 1);
    const result = await this.#ft.excelGetCell(id, view.token, sheet, row, col);
    if (seq !== this.#cellSeq || id !== this.#activeId()) return;
    if (!result.ok) {
      await this.#handleFailure(result.error, id);
      return;
    }
    this.cell = result.value;
  }

  /** 前・次の変更へ。無ければ何もしない。 */
  async moveToChange(direction: 1 | -1): Promise<void> {
    const layout = this.layout;
    if (layout === null) return;
    const target = nextChangedRow(layout.changedRows, this.selection?.row ?? null, direction);
    if (target === null) return;
    const col = this.rows.get(target)?.changedCols[0] ?? this.selection?.col ?? 0;
    this.#requestScroll(target, col);
    await this.selectCell(target, col);
  }

  toggleShowHidden(): void {
    this.showHidden = !this.showHidden;
  }

  /**
   * 更新・ウィンドウ復帰で status の世代が進んだ。一覧と、選んでいるファイルを取り直す
   * （main は HEAD 側を #49 で読み直す）。シート・選択・スクロールは保つ。
   */
  async reload(): Promise<void> {
    await this.loadFiles();
    const path = this.selectedPath;
    if (path !== null) await this.loadView(path, { keepSheet: true });
  }

  /** タブを切り替えた・タブの中身を捨てた。何も持たない状態に戻す。 */
  reset(): void {
    this.#listSeq += 1;
    this.files = [];
    this.filesTruncated = false;
    this.filesLoaded = false;
    this.filesLoading = false;
    this.selectedPath = null;
    this.#clearView();
    this.error = null;
  }

  /** キャッシュから戻ったタブ。選んでいたファイルだけを覚え直し、中身は ensure() が取る。 */
  restore(path: string | null): void {
    this.reset();
    this.selectedPath = path;
  }

  /**
   * Excel 差分モードを離れた。重いもの（幾何・行）を手放し、選択だけを残す。
   * 一覧は「取っていない」状態に戻す——他のモードでコミットや破棄をしても reload() は呼ばれないので、
   * 戻ってきたときに取り直させる（status のスナップショットを絞るだけで git は 0）。
   */
  release(): void {
    this.#clearView();
    this.filesLoaded = false;
  }

  #setSelectedPath(path: string | null): void {
    if (path === this.selectedPath) return;
    this.selectedPath = path;
    this.#clearView();
  }

  #clearView(): void {
    this.#viewSeq += 1;
    this.view = null;
    this.viewLoading = false;
    this.#clearSheet();
  }

  #clearSheet(): void {
    this.#sheetSeq += 1;
    this.#cellSeq += 1;
    this.sheet = null;
    this.layout = null;
    this.layoutLoading = false;
    this.rows.clear();
    this.#inflight.clear();
    this.selection = null;
    this.cell = null;
  }

  #requestScroll(row: number, col: number | null): void {
    this.scrollRequest = { row, col, seq: (this.#scrollSeq += 1) };
  }

  /**
   * 失敗の扱い。`diff-stale` は main のキャッシュが作り直された合図なので、ビューから取り直す
   * （シートと選択は保つ）。それ以外は画面と履歴に出す。
   */
  async #handleFailure(error: FtErrorDto, id: string): Promise<void> {
    const path = this.selectedPath;
    if (error.kind === 'diff-stale' && path !== null) {
      await this.loadView(path, { keepSheet: true });
      return;
    }
    if (error.kind === 'cancelled') return;
    this.error = error;
    this.#logError(error, id);
  }
}
