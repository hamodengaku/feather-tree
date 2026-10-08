<script lang="ts">
  /*
   * Excel 差分モード（決定 33）の本体。上 = 値バー、中 = 旧版 ｜ 新版のグリッド、下 = シートタブ。
   *
   * **比較は常に HEAD ↔ 作業ツリー**。ステージの口は持たない（読むだけのビューア）。
   * ただし未マージのファイルは「自分側 ｜ 相手側」を並べ、上の帯から採用を書き戻せる（決定 34）。
   *
   * 新旧の幾何は同一なので、行の高さ・列の幅の累積和はここで 1 回だけ作って両方に渡す。
   * スクロールの同期もここが持つ: 片方がスクロールしたら、相手の値が**違うときだけ**代入する
   * （mirrorScroll）。同じ値を代入しても scroll イベントは出ないので、往復で揺れない。
   *
   * どの状態でも必ず何か出す（白い画面にしない。要件 E7）。
   */
  import { untrack } from 'svelte';
  import { buildOffsets } from '@feathertree/base-ui';
  import ExcelConflictBar from '../components/ExcelConflictBar.svelte';
  import ExcelGrid from '../components/ExcelGrid.svelte';
  import ExcelSheetTabs from '../components/ExcelSheetTabs.svelte';
  import ExcelValueBar from '../components/ExcelValueBar.svelte';
  import { app } from '../lib/appState.svelte.js';
  import { effectiveColWidths, effectiveRowHeights, mirrorScroll, rowHeaderWidth } from '../lib/excelGrid.js';
  import { choiceAt, unresolvedInSheet, type ConflictSide } from '../lib/excelConflict.js';
  import {
    conflictSideNotice,
    conflictWorkbookSummary,
    sheetNotice,
    sheetWarnings,
    sideLabel,
    sideNotice,
    workbookSummary,
  } from '../lib/excelText.js';

  const ex = app.excel;

  /*
   * モードに入った瞬間・タブを替えた瞬間・一覧でファイルを選んだ瞬間に取りに行く。
   * ここが唯一の入口なので、**他のモードでいる限り #49 は 1 度も走らない**。
   */
  $effect(() => {
    void app.activeId;
    void ex.selectedPath;
    // ensure() の中で読む状態（読み込み中・ビュー）を依存にしない。依存にすると、取得に失敗したとき
    // 「読み込み中が終わった」ことで効果が走り直し、失敗し続ける限り取り直しを繰り返す
    untrack(() => void ex.ensure());
  });

  const view = $derived(ex.view);
  const layout = $derived(ex.layout);
  const sheet = $derived(view?.sheets.find((s) => s.index === ex.sheet) ?? null);
  /** 未マージなら左 = 自分側、右 = 相手側（決定 34）。 */
  const conflict = $derived(view?.conflict ?? null);

  const rowOffsets = $derived(layout === null ? new Float64Array(1) : buildOffsets(effectiveRowHeights(layout, ex.showHidden)));
  const colOffsets = $derived(layout === null ? new Float64Array(1) : buildOffsets(effectiveColWidths(layout, ex.showHidden)));
  const headerWidth = $derived(rowHeaderWidth(layout));

  /** 側ごとの案内。ブックが読めない → シートがその側に無い、の順に見る。 */
  function noticeFor(side: 'old' | 'new'): string | null {
    if (view === null) return null;
    const state = side === 'old' ? view.old.state : view.new.state;
    const conflictNotice = conflict === null ? null : conflictSideNotice(side, state);
    if (conflictNotice !== null) return conflictNotice;
    const bookNotice = sideNotice(side, side === 'old' ? view.old.state : view.new.state);
    if (bookNotice !== null) return bookNotice;
    return sheet === null ? null : sheetNotice(side, sheet);
  }
  const oldNotice = $derived(noticeFor('old'));
  const newNotice = $derived(noticeFor('new'));
  const oldDetail = $derived(view?.old.state === 'lfs-failed' ? view.old.detail : null);
  const warnings = $derived(sheet === null ? [] : sheetWarnings(sheet));

  let oldViewport = $state<HTMLDivElement | null>(null);
  let newViewport = $state<HTMLDivElement | null>(null);

  function sync(from: 'old' | 'new', top: number, left: number): void {
    const target = from === 'old' ? newViewport : oldViewport;
    if (target === null) return;
    const m = mirrorScroll({ top, left }, { top: target.scrollTop, left: target.scrollLeft });
    if (m.top !== null) target.scrollTop = m.top;
    if (m.left !== null) target.scrollLeft = m.left;
  }

  /** 見えている側（案内で塞がれていない側）の本体。スクロールの依頼はこちらに掛ける。 */
  function liveViewport(): HTMLDivElement | null {
    return oldNotice === null && oldViewport !== null ? oldViewport : newViewport;
  }

  /**
   * 「次の変更へ」・シートを開いた直後の最初の変更: その行が見えていなければ、上から 1/3 の位置へ。
   * **依頼 1 件につき 1 回だけ**動かす（非表示の切り替えで大きさが変わるたびに、古い依頼の位置へ戻さない）。
   */
  let handledScroll = 0;
  $effect(() => {
    const request = ex.scrollRequest;
    const el = liveViewport();
    if (request === null || el === null || layout === null || request.seq === handledScroll) return;
    handledScroll = request.seq;
    untrack(() => scrollToRequest(request.row, request.col, el));
  });

  function scrollToRequest(row: number, col: number | null, el: HTMLDivElement): void {
    const rowTop = rowOffsets[row] ?? 0;
    const rowBottom = rowOffsets[row + 1] ?? rowTop;
    if (rowTop < el.scrollTop || rowBottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, rowTop - el.clientHeight / 3);
    }
    if (col !== null) {
      const colLeft = colOffsets[col] ?? 0;
      const colRight = colOffsets[col + 1] ?? colLeft;
      if (colLeft < el.scrollLeft || colRight > el.scrollLeft + el.clientWidth) {
        el.scrollLeft = Math.max(0, colLeft - el.clientWidth / 3);
      }
    }
    sync(el === oldViewport ? 'old' : 'new', el.scrollTop, el.scrollLeft);
  }

  function handleNeed(start: number, end: number): void {
    ex.ensureRows(start, end);
  }

  function handleSelect(row: number, col: number): void {
    void ex.selectCell(row, col);
  }

  /** グリッドに出す採り方の印（セル単位で採れるときだけ）。 */
  const choiceOf = $derived.by(() => {
    const index = ex.sheet;
    if (conflict?.cellResolvable !== true || layout === null || index === null || sheet?.conflict == null) return null;
    const summary = sheet;
    const choices = ex.choices;
    return (row: number, col: number): ConflictSide | null => choiceAt(summary, choices, index, row, col);
  });
</script>

<section class="excel-pane" aria-label="Excel 差分">
  {#if app.activeId === null}
    <p class="empty">リポジトリを開くと Excel の差分を表示します。</p>
  {:else if ex.selectedPath === null}
    {#if ex.error !== null}
      <p class="empty error">{ex.error.message}</p>
    {:else}
      <p class="empty">
        {ex.filesLoaded ? '変更のある Excel / CSV ファイルはありません。' : '読み込み中…'}
      </p>
    {/if}
  {:else if ex.error !== null && view === null}
    <p class="empty error">{ex.error.message}</p>
  {:else if view === null}
    <p class="empty">読み込み中…（HEAD 側の取り出しに Git LFS のダウンロードが走ることがあります）</p>
  {:else}
    <header class="head">
      <h2 title={view.path}>{view.path}</h2>
      <span class="meta">
        {#if conflict !== null}
          自分側 ↔ 相手側・{conflictWorkbookSummary(view.sheets)}
        {:else}
          HEAD ↔ 作業ツリー・{workbookSummary(view.sheets, view.old, view.new)}
        {/if}
        {#if view.headPath !== view.path}・元の名前 {view.headPath}{/if}
        {#if view.vbaChanged === true}・マクロが変更されています{/if}
      </span>
      {#if ex.viewLoading || ex.layoutLoading}
        <span class="meta">読み込み中…</span>
      {/if}
    </header>

    {#if conflict !== null}
      <ExcelConflictBar {view} {conflict} />
    {/if}

    <ExcelValueBar cell={ex.cell} conflict={conflict !== null} />

    {#each warnings as w (w)}
      <p class="notice">{w}</p>
    {/each}

    <div class="sides">
      <div class="side-label">{sideLabel('old', conflict !== null)}</div>
      <div class="side-label">{sideLabel('new', conflict !== null)}</div>
    </div>

    <div class="grids">
      {#if layout === null}
        <p class="empty span">{sheet === null ? 'シートがありません。' : '読み込み中…'}</p>
      {:else}
        <div class="side">
          {#if oldNotice !== null}
            <div class="side-notice">
              <p>{oldNotice}</p>
              {#if oldDetail !== null}<pre class="detail">{oldDetail}</pre>{/if}
            </div>
          {:else}
            <ExcelGrid
              side="old"
              {layout}
              {rowOffsets}
              {colOffsets}
              rowHeaderWidth={headerWidth}
              rows={ex.rows}
              selection={ex.selection}
              {choiceOf}
              bind:viewport={oldViewport}
              onscroll={(top, left) => sync('old', top, left)}
              onneed={handleNeed}
              onselect={handleSelect}
            />
          {/if}
        </div>
        <div class="divider" aria-hidden="true"></div>
        <div class="side">
          {#if newNotice !== null}
            <div class="side-notice"><p>{newNotice}</p></div>
          {:else}
            <ExcelGrid
              side="new"
              {layout}
              {rowOffsets}
              {colOffsets}
              rowHeaderWidth={headerWidth}
              rows={ex.rows}
              selection={ex.selection}
              {choiceOf}
              bind:viewport={newViewport}
              onscroll={(top, left) => sync('new', top, left)}
              onneed={handleNeed}
              onselect={handleSelect}
            />
          {/if}
        </div>
      {/if}
    </div>

    <ExcelSheetTabs
      sheets={view.sheets}
      current={ex.sheet}
      {layout}
      showHidden={ex.showHidden}
      onselect={(i) => void ex.selectSheet(i)}
      onmove={(d) => void ex.moveToChange(d)}
      ontogglehidden={() => ex.toggleShowHidden()}
      unresolvedOf={conflict?.cellResolvable === true ? (sh) => unresolvedInSheet(sh, ex.choices) : null}
    />
  {/if}
</section>

<style>
  .excel-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
    background: var(--app-bg-base, var(--app-bg-surface));
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: var(--app-metric-gap);
    padding: 6px 8px;
    background: var(--app-bg-surface);
    border-bottom: 1px solid var(--app-border-subtle);
    overflow: hidden;
  }

  h2 {
    margin: 0;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .sides {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 1px;
    background: var(--app-border-strong);
    font-size: var(--app-font-size-mono);
  }

  .side-label {
    padding: 2px 8px;
    background: var(--app-bg-raised);
    color: var(--app-text-secondary);
  }

  .grids {
    flex: 1 1 auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 1px minmax(0, 1fr);
    min-height: 0;
  }

  .side {
    display: grid;
    min-width: 0;
    min-height: 0;
  }

  .divider {
    background: var(--app-border-strong);
  }

  .side-notice {
    padding: 16px;
    color: var(--app-text-secondary);
    background: var(--app-bg-surface);
    overflow: auto;
  }

  .side-notice p {
    margin: 0;
    line-height: 1.6;
  }

  .detail {
    margin: 8px 0 0;
    padding: 6px;
    white-space: pre-wrap;
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    color: var(--app-text-muted);
    background: var(--app-bg-raised);
  }

  .empty {
    margin: 0;
    padding: 12px;
    color: var(--app-text-secondary);
    font-size: var(--app-font-size-ui);
  }

  .empty.span {
    grid-column: 1 / -1;
  }

  .empty.error {
    color: var(--app-text-danger);
  }

  .notice {
    flex: 0 0 auto;
    margin: 0;
    padding: 4px 12px;
    border-bottom: 1px solid var(--app-border-subtle);
    background: var(--app-bg-raised);
    color: var(--app-text-conflict);
    font-size: var(--app-font-size-ui);
  }
</style>
