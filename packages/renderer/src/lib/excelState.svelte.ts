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
  ExcelSheetSummaryDto,
  ExcelViewDto,
  FeatherTreeBridge,
  FtErrorDto,
} from '@feathertree/ipc';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
  cellKey,
  choiceForCell,
  blocksInRanges,
  isBothOrder,
  isOneSidedRow,
  lineKey,
  nextUnresolved,
  rangeOf,
  targetsInRanges,
  type BothBlock,
  type BothOrder,
  type CellRange,
  type RowChoice,
  type ConflictChoiceState,
  type ConflictSide,
} from './excelConflict.js';
import { nextChangedRow, pagesFor, ROW_PAGE } from './excelGrid.js';

/** 同じ値ならキーを外し、違えば入れる（採り方のボタンの押し直しで外す）。 */
function toggle<K, V extends string>(map: SvelteMap<K, V>, key: K, side: V): void {
  if (map.get(key) === side) map.delete(key);
  else map.set(key, side);
}

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

  /*
   * コンフリクトの採り方（決定 34）。キーは揃えた座標。**比較の出どころ（パスと作業ツリーの指紋）が
   * 同じ間だけ持ち越す**——更新・ウィンドウ復帰ではトークンが変わるが、作業ツリーが同じなら揃え方も同じなので、
   * 決めたものを捨てない。書き込んだ（指紋が変わった）ら捨てる。
   */
  /** キーは `シート:揃えた行:列` / `シート:揃えた行` / `シート:列`（lib/excelConflict.ts）。 */
  readonly conflictCells = new SvelteMap<string, ConflictSide>();
  readonly conflictRows = new SvelteMap<string, RowChoice>();
  /** 続いた行の範囲で両方を採用（docs/07 7.2）。キーは `シート:範囲の先頭の揃えた行`。 */
  readonly conflictHunks = new SvelteMap<string, BothBlock>();
  readonly conflictCols = new SvelteMap<string, ConflictSide>();
  conflictRest = $state<ConflictSide | null>(null);
  /** 打った値（docs/07 7.1）。キーは `シート:揃えた行:列`。 */
  readonly conflictEdits = new SvelteMap<string, string>();
  #choicesKey: string | null = null;

  /** 選んでいる範囲（揃えた座標）。左右のグリッドで共有する。selection はその中の「今のセル」。 */
  ranges = $state<readonly CellRange[]>([]);
  /** Shift で範囲を広げるときの起点。 */
  #anchor: { row: number; col: number } | null = null;
  /** ドラッグ中なら、押し始めた所の種類。 */
  #drag: 'cell' | 'row' | 'col' | null = null;
  /** 編集中のセル（入力欄を出すグリッドと、今の文字）。 */
  editing = $state<{ sheet: number; row: number; col: number; side: 'old' | 'new'; value: string } | null>(null);

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
      this.#syncChoices(view);

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
      this.ranges = [];
      this.editing = null;
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

  /**
   * セルを選ぶ。値バーの中身（旧値・新値・数式）を取りに行く。
   * keepRanges が偽なら、選択範囲もこのセル 1 つにする（移動・次の変更へなど、マウス以外からの選択）。
   */
  async selectCell(row: number, col: number, keepRanges = false): Promise<void> {
    const id = this.#activeId();
    const view = this.view;
    const sheet = this.sheet;
    if (id === null || view === null || sheet === null) return;
    this.selection = { row, col };
    if (!keepRanges) {
      this.ranges = [rangeOf({ row, col }, { row, col })];
      this.#anchor = { row, col };
    }
    if (this.editing !== null && (this.editing.row !== row || this.editing.col !== col)) this.editing = null;
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

  // ---------------------------------------------------------------- コンフリクトの採り方（決定 34）

  /** 今の採り方（純関数 lib/excelConflict.ts に渡す形）。 */
  get choices(): ConflictChoiceState {
    return {
      cells: this.conflictCells,
      rows: this.conflictRows,
      cols: this.conflictCols,
      rest: this.conflictRest,
      edits: this.conflictEdits,
      hunks: this.conflictHunks,
    };
  }

  // ---------------------------------------------------------------- 範囲の選択（docs/07 7.1）

  /**
   * マウスを押した。Shift なら起点から範囲を広げ、Ctrl なら範囲を足す（Excel と同じ）。
   * kind は押した所: セル・行番号・列番号。押したまま動かすと onPointerEnter で範囲が伸びる。
   */
  pointerDown(kind: 'cell' | 'row' | 'col', row: number, col: number, mods: { shift: boolean; ctrl: boolean }): void {
    const layout = this.layout;
    if (layout === null) return;
    const at = this.#clampPos(kind, row, col);
    const anchor = mods.shift && this.#anchor !== null ? this.#anchor : at;
    const range = this.#rectFor(kind, anchor, at);
    if (mods.shift && this.ranges.length > 0) this.ranges = [...this.ranges.slice(0, -1), range];
    else if (mods.ctrl) this.ranges = [...this.ranges, range];
    else this.ranges = [range];
    if (!mods.shift) this.#anchor = at;
    this.#drag = kind;
    // 値バーと帯の「選んでいる所」は、押したセル（Shift なら起点のまま）
    const active = mods.shift ? anchor : at;
    void this.selectCell(active.row, active.col, true);
  }

  /** 押したまま別の所に入った。直前の範囲を起点からそこまでに伸ばす。 */
  pointerEnter(kind: 'cell' | 'row' | 'col', row: number, col: number): void {
    const drag = this.#drag;
    const anchor = this.#anchor;
    if (drag === null || anchor === null || this.ranges.length === 0) return;
    // 行番号で始めたドラッグは行全体、列番号なら列全体のまま伸ばす
    const at = this.#clampPos(drag === 'cell' ? kind : drag, row, col);
    this.ranges = [...this.ranges.slice(0, -1), this.#rectFor(drag, anchor, at)];
  }

  pointerUp(): void {
    this.#drag = null;
  }

  #clampPos(kind: 'cell' | 'row' | 'col', row: number, col: number): { row: number; col: number } {
    const layout = this.layout;
    const maxRow = Math.max(0, (layout?.rowCount ?? 1) - 1);
    const maxCol = Math.max(0, (layout?.colCount ?? 1) - 1);
    return {
      row: kind === 'col' ? 0 : Math.min(maxRow, Math.max(0, row)),
      col: kind === 'row' ? 0 : Math.min(maxCol, Math.max(0, col)),
    };
  }

  #rectFor(kind: 'cell' | 'row' | 'col', a: { row: number; col: number }, b: { row: number; col: number }): CellRange {
    const layout = this.layout;
    const lastRow = Math.max(0, (layout?.rowCount ?? 1) - 1);
    const lastCol = Math.max(0, (layout?.colCount ?? 1) - 1);
    if (kind === 'row') return { r1: Math.min(a.row, b.row), c1: 0, r2: Math.max(a.row, b.row), c2: lastCol };
    if (kind === 'col') return { r1: 0, c1: Math.min(a.col, b.col), r2: lastRow, c2: Math.max(a.col, b.col) };
    return rangeOf(a, b);
  }

  /** 選んだ範囲に含まれる決めるべき所（今のシート）。 */
  get selectionTargets(): { readonly cells: readonly { row: number; col: number }[]; readonly rows: readonly number[] } {
    return targetsInRanges(this.#summary(), this.ranges);
  }

  /**
   * 選んだ範囲の決めるべき所に、まとめて採り方を当てる（右クリックの「ours を採用」など）。
   * null なら個別の指定（セル・片側だけの行の指定と打った値）を外す。
   */
  chooseSelection(side: ConflictSide | null): void {
    const sheet = this.sheet;
    if (sheet === null) return;
    const { cells, rows } = this.selectionTargets;
    // 片側を採るなら、範囲に掛かる「両方を採用」は外す（そちらが強いので、残すと効かない）
    for (const b of blocksInRanges(this.#summary(), this.ranges)) this.#dropBlocks(sheet, b.start, b.end);
    for (const c of cells) {
      const key = lineKey(sheet, c.row);
      if (isBothOrder(this.conflictRows.get(key))) this.conflictRows.delete(key);
    }
    for (const c of cells) {
      const key = cellKey(sheet, c.row, c.col);
      this.conflictEdits.delete(key);
      if (side === null) this.conflictCells.delete(key);
      else this.conflictCells.set(key, side);
    }
    for (const r of rows) {
      const key = lineKey(sheet, r);
      if (side === null) this.conflictRows.delete(key);
      else this.conflictRows.set(key, side);
    }
  }

  // ---------------------------------------------------------------- 両方を採用（docs/07 7.2）

  /** 範囲が掛かる「両方を採用」の単位（ブロックごとの、選んだ行の続いた範囲）。 */
  get selectionBlocks(): readonly { start: number; end: number }[] {
    return blocksInRanges(this.#summary(), this.ranges);
  }

  /**
   * 選んだ行で両方を採用する。同じ範囲に同じ並びが既にあれば外す（押し直し）。重なる範囲は置き換える。
   */
  chooseBothSelection(order: BothOrder): void {
    const sheet = this.sheet;
    if (sheet === null) return;
    for (const b of this.selectionBlocks) {
      const same = this.conflictHunks.get(lineKey(sheet, b.start));
      this.#dropBlocks(sheet, b.start, b.end);
      if (same?.end === b.end && same.order === order) continue;
      this.conflictHunks.set(lineKey(sheet, b.start), { end: b.end, order });
    }
  }

  /** [start, end) と重なる「両方を採用」を外す。 */
  #dropBlocks(sheet: number, start: number, end: number): void {
    const prefix = String(sheet) + ':';
    for (const [key, block] of [...this.conflictHunks]) {
      if (!key.startsWith(prefix)) continue;
      const s = Number(key.slice(prefix.length));
      if (s < end && block.end > start) this.conflictHunks.delete(key);
    }
  }

  // ---------------------------------------------------------------- セルの編集（docs/07 7.1）

  /**
   * 編集できるか: 範囲が 1 セルだけで、それが両側にある行の値の違うセル。
   */
  get editableCell(): { row: number; col: number } | null {
    const range = this.ranges.length === 1 ? this.ranges[0] : undefined;
    if (range === undefined || range.r1 !== range.r2 || range.c1 !== range.c2) return null;
    const { cells } = this.selectionTargets;
    return cells.length === 1 ? (cells[0] ?? null) : null;
  }

  /** 打った値（無ければ undefined）。 */
  editOf(row: number, col: number): string | undefined {
    return this.sheet === null ? undefined : this.conflictEdits.get(cellKey(this.sheet, row, col));
  }

  /**
   * 編集を始める。initial を渡せばそれで始め（文字の打鍵）、無ければ今の値（打った値 → 採った側の値 → 自分側の値）。
   * side は入力欄を出すグリッド。
   */
  startEdit(side: 'old' | 'new', initial?: string): void {
    const target = this.editableCell;
    const sheet = this.sheet;
    if (target === null || sheet === null) return;
    let value = initial;
    if (value === undefined) {
      const typed = this.editOf(target.row, target.col);
      const chosen = choiceForCell(this.choices, sheet, target.row, target.col, this.#summary());
      const cell = this.cell !== null && this.cell.row === target.row && this.cell.col === target.col ? this.cell : null;
      value = typed ?? (chosen === 'theirs' ? cell?.new?.raw : cell?.old?.raw) ?? '';
    }
    this.editing = { sheet, row: target.row, col: target.col, side, value };
  }

  /** 編集を確かめる（Enter・欄の外を押す）。 */
  commitEdit(value: string): void {
    const editing = this.editing;
    if (editing === null) return;
    this.editing = null;
    this.conflictEdits.set(cellKey(editing.sheet, editing.row, editing.col), value);
    // 打った値を効かせるため、その行・ブロックの「両方を採用」は外す（そちらが強い）
    const rowKey = lineKey(editing.sheet, editing.row);
    if (isBothOrder(this.conflictRows.get(rowKey))) this.conflictRows.delete(rowKey);
    this.#dropBlocks(editing.sheet, editing.row, editing.row + 1);
  }

  cancelEdit(): void {
    this.editing = null;
  }

  /**
   * 選んでいるセルの採り方を決める。同じ側をもう一度押すと外す。
   * 片側にしか無い行ではセルの指定が効かないので、行の指定にする。
   */
  chooseCell(side: ConflictSide): void {
    const sel = this.selection;
    const sheet = this.sheet;
    if (sel === null || sheet === null) return;
    if (isOneSidedRow(this.#summary(), sel.row)) {
      this.chooseRow(side);
      return;
    }
    // 打った値はセルの指定より強いので、側を選び直したら外す
    this.conflictEdits.delete(cellKey(sheet, sel.row, sel.col));
    toggle(this.conflictCells, cellKey(sheet, sel.row, sel.col), side);
  }

  /** 選んでいるセルの行の採り方を決める。同じ側をもう一度押すと外す。 */
  chooseRow(side: ConflictSide): void {
    const sel = this.selection;
    if (sel !== null && this.sheet !== null) toggle(this.conflictRows, lineKey(this.sheet, sel.row), side);
  }

  /** 選んでいるセルの列の採り方を決める。同じ側をもう一度押すと外す。 */
  chooseCol(side: ConflictSide): void {
    const sel = this.selection;
    if (sel !== null && this.sheet !== null) toggle(this.conflictCols, lineKey(this.sheet, sel.col), side);
  }

  /** 個別に決めていない残りすべて。同じ側をもう一度押すと外す。 */
  chooseRest(side: ConflictSide): void {
    this.conflictRest = this.conflictRest === side ? null : side;
  }

  clearChoices(): void {
    this.conflictHunks.clear();
    this.conflictEdits.clear();
    this.editing = null;
    this.conflictCells.clear();
    this.conflictRows.clear();
    this.conflictCols.clear();
    this.conflictRest = null;
  }

  /** 次の未決定へ（別のシートならシートを開く。無ければ何もしない）。 */
  async moveToUnresolved(): Promise<void> {
    const view = this.view;
    const sheet = this.sheet;
    if (view === null) return;
    const from = sheet === null || this.selection === null ? null : { sheet, ...this.selection };
    const target = nextUnresolved(view.sheets, this.choices, from);
    if (target === null) return;
    if (target.sheet !== this.sheet) await this.selectSheet(target.sheet);
    if (this.sheet !== target.sheet) return;
    this.#requestScroll(target.row, target.col);
    await this.selectCell(target.row, target.col);
  }

  /** 今のシートの概要。 */
  #summary(): ExcelSheetSummaryDto | undefined {
    return this.view?.sheets.find((s) => s.index === this.sheet);
  }

  #syncChoices(view: ExcelViewDto): void {
    const conflict = view.conflict ?? null;
    const key = conflict !== null && conflict.source === 'markers' ? view.path + '|' + conflict.fingerprint : null;
    if (key === this.#choicesKey) return;
    this.#choicesKey = key;
    this.clearChoices();
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
    this.#choicesKey = null;
    this.clearChoices();
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
    this.ranges = [];
    this.#anchor = null;
    this.editing = null;
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
