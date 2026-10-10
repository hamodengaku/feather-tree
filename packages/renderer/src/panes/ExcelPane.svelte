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
   * コンフリクトの採り方の規則（印・プレビュー・未決定の数）は @feathertree/conflict-plan の SheetRules を
   * $derived で 1 回だけ作り、セルごとに使い回す（書き込みと同じ規則）。
   *
   * どの状態でも必ず何か出す（白い画面にしない。要件 E7）。
   */
  import { untrack } from 'svelte';
  import { buildOffsets } from '@feathertree/base-ui';
  import { hasAnyChoice, planIndexOf, planSheet, type EffectiveChoice } from '@feathertree/conflict-plan';
  import ExcelConflictBar from '../components/ExcelConflictBar.svelte';
  import ExcelGrid from '../components/ExcelGrid.svelte';
  import ExcelSheetTabs from '../components/ExcelSheetTabs.svelte';
  import ExcelValueBar from '../components/ExcelValueBar.svelte';
  import ExcelPreviewGrid from '../components/ExcelPreviewGrid.svelte';
  import FileContextMenu from '../components/FileContextMenu.svelte';
  import { app } from '../lib/appState.svelte.js';
  import { effectiveColWidths, effectiveRowHeights, mirrorScroll, rowHeaderWidth } from '../lib/excelGrid.js';
  import { inRanges, rulesFor } from '../lib/excelConflict.js';
  import { buildConflictMenu, type ConflictMenuCommand } from '../lib/excelMenu.js';
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

  const rowHeights = $derived(layout === null ? new Float64Array(0) : effectiveRowHeights(layout, ex.showHidden));
  const rowOffsets = $derived(layout === null ? new Float64Array(1) : buildOffsets(rowHeights));
  const colOffsets = $derived(layout === null ? new Float64Array(1) : buildOffsets(effectiveColWidths(layout, ex.showHidden)));
  const headerWidth = $derived(rowHeaderWidth(layout));

  /** 今のシートの採り方の規則。セル単位で採れるコンフリクトのときだけ。 */
  const rules = $derived(conflict?.cellResolvable === true ? rulesFor(sheet, ex.choices) : null);

  /** 側ごとの案内。ブックが読めない → シートがその側に無い、の順に見る。 */
  function noticeFor(side: 'old' | 'new'): string | null {
    if (view === null) return null;
    const state = side === 'old' ? view.old.state : view.new.state;
    const conflictNotice = conflict === null ? null : conflictSideNotice(side, state);
    if (conflictNotice !== null) return conflictNotice;
    const bookNotice = sideNotice(side, state);
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
    // 横だけはプレビューとも揃える（列は共通。縦は行の並びが違う）
    if (previewViewport !== null && previewViewport.scrollLeft !== left) previewViewport.scrollLeft = left;
    if (target === null) return;
    const m = mirrorScroll({ top, left }, { top: target.scrollTop, left: target.scrollLeft });
    if (m.top !== null) target.scrollTop = m.top;
    if (m.left !== null) target.scrollLeft = m.left;
  }

  // ---------------------------------------------------------------- マージ後のプレビュー（docs/07 7.3）

  let previewViewport = $state<HTMLDivElement | null>(null);

  /** 採り方を 1 つでも決めたら、3 つ目のペインとして出す。 */
  const previewOn = $derived(rules !== null && layout !== null && hasAnyChoice(ex.choices));
  /** 書き込み後の行の並び（書き込みと同じ planSheet）。 */
  const previewRows = $derived(previewOn && rules !== null && layout !== null ? planSheet(rules, layout).rows : []);
  const previewIndex = $derived(planIndexOf(previewRows));

  /** 上のグリッドで選んだ行へ、プレビューを動かす。 */
  let previewFocusSeq = 0;
  const previewFocus = $derived.by(() => {
    const row = ex.selection?.row;
    const index = row === undefined ? undefined : previewIndex.get(row);
    if (index === undefined) return null;
    previewFocusSeq += 1;
    return { index, seq: previewFocusSeq };
  });

  function syncFromPreview(left: number): void {
    for (const el of [oldViewport, newViewport]) {
      if (el !== null && el.scrollLeft !== left) el.scrollLeft = left;
    }
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

  /** 最後に触ったグリッド（打鍵で編集を始めるとき、入力欄をそちらに出す）。 */
  let activeSide = $state<'old' | 'new'>('new');

  function handlePointer(
    side: 'old' | 'new',
    kind: 'cell' | 'row' | 'col',
    row: number,
    col: number,
    mods: { shift: boolean; ctrl: boolean },
  ): void {
    activeSide = side;
    ex.pointerDown(kind, row, col, mods);
  }

  // ---------------------------------------------------------------- 右クリックのメニュー（docs/07 7.1）

  let menu = $state<{ x: number; y: number; side: 'old' | 'new' } | null>(null);

  function openMenu(side: 'old' | 'new', row: number, col: number, x: number, y: number): void {
    activeSide = side;
    // 範囲の外を右クリックしたら、そのセルを選び直す（Excel と同じ）
    if (!inRanges(ex.ranges, row, col)) ex.pointerDown('cell', row, col, { shift: false, ctrl: false });
    ex.pointerUp();
    menu = { x, y, side };
  }

  function displayAt(row: number, col: number, side: 'old' | 'new'): string {
    const r = ex.rows.get(row)?.[side] ?? null;
    if (r === null) return '';
    const i = r.cols.indexOf(col);
    return i < 0 ? '' : (r.text[i] ?? '');
  }

  function run(command: ConflictMenuCommand, side: 'old' | 'new'): void {
    switch (command.kind) {
      case 'side':
        ex.chooseSelection(command.side);
        break;
      case 'both':
        ex.chooseBothSelection(command.order);
        break;
      case 'clear':
        ex.chooseSelection(null);
        break;
      case 'rest':
        ex.choices.rest = command.side;
        break;
      case 'edit':
        ex.startEdit(side);
        break;
    }
  }

  const menuActions = $derived.by(() => {
    const m = menu;
    if (m === null || layout === null || rules === null) return [];
    const { cells, rows } = ex.selectionTargets;
    const index = rules.index;
    const oneCell = cells.length === 1 && rows.length === 0 ? cells[0] : undefined;
    const oneRow = rows.length === 1 && cells.length === 0 ? rows[0] : undefined;
    const reasons = [...cells.map((c) => index.blockReasonAt(c.row, c.col)), ...rows.map((r) => index.blockReasonAt(r, -1))];
    const items = buildConflictMenu({
      cells,
      rows,
      bothSpans: ex.selectionBlocks.length,
      blocked: reasons.find((r) => r !== null) ?? null,
      bothBlocked: index.bothBlocked,
      cellText:
        oneCell === undefined
          ? null
          : { ours: displayAt(oneCell.row, oneCell.col, 'old'), theirs: displayAt(oneCell.row, oneCell.col, 'new') },
      rowInOurs: oneRow === undefined ? null : (layout.oldRow[oneRow] ?? -1) >= 0,
      editable: ex.editableCell !== null,
    });
    return items.map((item) => {
      const command = item.command;
      return {
        label: item.label,
        disabled: item.disabled,
        onclick: () => {
          if (command !== null) run(command, m.side);
        },
      };
    });
  });

  // ---------------------------------------------------------------- セルの編集（docs/07 7.1）

  /**
   * そのセルで編集を始められるか: 1 セルだけ選んでいて、それが値の違うセルで、相手側を採れない所でない。
   * row・col を渡せば、そのセルを選んでいることも確かめる（ダブルクリック）。
   */
  function canStartEdit(at?: { row: number; col: number }): boolean {
    const target = ex.editableCell;
    if (rules === null || ex.editing !== null || target === null) return false;
    if (at !== undefined && (target.row !== at.row || target.col !== at.col)) return false;
    return rules.index.blockReasonAt(target.row, target.col) === null;
  }

  /** グリッドに焦点があるときの打鍵。1 セルだけ選んでいれば、F2・Enter・文字で編集を始める。 */
  function gridKey(e: KeyboardEvent): void {
    if (!canStartEdit()) return;
    if (e.key === 'F2' || e.key === 'Enter') {
      e.preventDefault();
      ex.startEdit(activeSide);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      ex.startEdit(activeSide, e.key);
    }
  }

  function startEditAt(side: 'old' | 'new', row: number, col: number): void {
    activeSide = side;
    if (canStartEdit({ row, col })) ex.startEdit(side);
  }

  /** そのグリッドで編集中のセル。 */
  function editingOn(side: 'old' | 'new'): { row: number; col: number; value: string } | null {
    const e = ex.editing;
    return e !== null && e.side === side && e.sheet === ex.sheet ? e : null;
  }

  /** グリッドに出す採り方の印（セル単位で採れるときだけ）。 */
  const choiceOf = $derived.by(() => {
    const r = rules;
    return r === null ? null : (row: number, col: number): EffectiveChoice | null => r.choiceAt(row, col);
  });
</script>

<svelte:window onmouseup={() => ex.pointerUp()} />

{#if menu !== null && menuActions.length > 0}
  <FileContextMenu x={menu.x} y={menu.y} actions={menuActions} onclose={() => (menu = null)} />
{/if}

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
      {#snippet sideHead(which: 'old' | 'new')}
        <div class="side-label">
          <span class="side-name">{sideLabel(which, conflict !== null)}</span>
          {#if conflict !== null}
            {@const absent = (which === 'old' ? view.old.state : view.new.state) === 'absent'}
            <!-- ファイル全体の採用（docs/07 7.0）。削除された側は採れない（削除は差分モードで行う） -->
            <button
              class="adopt {which === 'old' ? 'ours' : 'theirs'}"
              disabled={app.busy || absent}
              title={absent
                ? 'この側ではファイルが削除されています（削除は差分モードで行ってください）'
                : 'ファイル全体を' + (which === 'old' ? '自分側' : '相手側') + 'の内容にして作業ツリーへ書き込みます'}
              onclick={() => void app.resolveExcelConflict({ kind: 'file', side: which === 'old' ? 'ours' : 'theirs' })}
            >
              {which === 'old' ? '自分側を採用' : '相手側を採用'}
            </button>
          {/if}
        </div>
      {/snippet}
      {@render sideHead('old')}
      {@render sideHead('new')}
    </div>

    <!-- 打鍵はグリッドの本体（焦点を持つ）から泡立ってくる -->
    <div class="grids" role="presentation" onkeydown={gridKey}>
      {#if layout === null}
        <p class="empty span">{sheet === null ? 'シートがありません。' : '読み込み中…'}</p>
      {:else}
        <!-- 左右のグリッドは側だけが違う（old = 自分側、new = 相手側） -->
        {#snippet grid(which: 'old' | 'new')}
          <ExcelGrid
            side={which}
            {layout}
            {rowOffsets}
            {colOffsets}
            rowHeaderWidth={headerWidth}
            rows={ex.rows}
            selection={ex.selection}
            {choiceOf}
            bind:viewport={
              () => (which === 'old' ? oldViewport : newViewport),
              (v) => {
                if (which === 'old') oldViewport = v ?? null;
                else newViewport = v ?? null;
              }
            }
            onscroll={(top, left) => sync(which, top, left)}
            onneed={handleNeed}
            ranges={ex.ranges}
            onpointer={(kind, row, col, m) => handlePointer(which, kind, row, col, m)}
            onpointerenter={(kind, row, col) => ex.pointerEnter(kind, row, col)}
            oncontext={rules !== null ? (row, col, x, y) => openMenu(which, row, col, x, y) : undefined}
            ondblcell={(row, col) => startEditAt(which, row, col)}
            editing={editingOn(which)}
            oneditcommit={(value) => ex.commitEdit(value)}
            oneditcancel={() => ex.cancelEdit()}
          />
        {/snippet}
        <div class="side">
          {#if oldNotice !== null}
            <div class="side-notice">
              <p>{oldNotice}</p>
              {#if oldDetail !== null}<pre class="detail">{oldDetail}</pre>{/if}
            </div>
          {:else}
            {@render grid('old')}
          {/if}
        </div>
        <div class="divider" aria-hidden="true"></div>
        <div class="side">
          {#if newNotice !== null}
            <div class="side-notice"><p>{newNotice}</p></div>
          {:else}
            {@render grid('new')}
          {/if}
        </div>
      {/if}
    </div>

    {#if previewOn && layout !== null}
      <!-- 3 つ目のペイン: マージ後のプレビュー（docs/07 7.3） -->
      <div class="preview-label">
        <span class="preview-title">マージ後のプレビュー</span>
        <span class="legend">
          <span class="mark theirs">相手側から</span>
          <span class="mark edited">手入力</span>
          <span class="mark undecided">未決定（自分側のまま表示）</span>
        </span>
      </div>
      <div class="preview">
        <ExcelPreviewGrid
          {layout}
          {previewRows}
          rows={ex.rows}
          {rowHeights}
          {colOffsets}
          rowHeaderWidth={headerWidth}
          selectedAligned={ex.selection?.row ?? null}
          focusRow={previewFocus}
          bind:viewport={previewViewport}
          onscroll={syncFromPreview}
          onneed={handleNeed}
          ondblcell={(index, row, col, side) => void ex.startPreviewEdit(index, row, col, side)}
          editing={ex.editing !== null && ex.editing.side === 'preview' && ex.editing.sheet === ex.sheet
            ? { index: ex.editing.previewIndex ?? 0, col: ex.editing.col, value: ex.editing.value }
            : null}
          oneditcommit={(value) => ex.commitEdit(value)}
          oneditcancel={() => ex.cancelEdit()}
          onselect={(row, col) => {
            ex.pointerDown('cell', row, col, { shift: false, ctrl: false });
            ex.pointerUp();
          }}
        />
      </div>
    {/if}

    <ExcelSheetTabs
      sheets={view.sheets}
      current={ex.sheet}
      {layout}
      showHidden={ex.showHidden}
      onselect={(i) => void ex.selectSheet(i)}
      onmove={(d) => void ex.moveToChange(d)}
      ontogglehidden={() => ex.toggleShowHidden()}
      unresolvedOf={conflict?.cellResolvable === true ? (sh) => (rulesFor(sh, ex.choices)?.unresolved() ?? 0) : null}
    />
  {/if}
</section>

<style>
  .side-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .adopt {
    flex: 0 0 auto;
    padding: 0 8px;
    font-size: var(--app-font-size-mono);
  }

  .adopt.ours:not(:disabled) {
    border-color: var(--app-text-modified);
  }

  .adopt.theirs:not(:disabled) {
    border-color: var(--app-text-added);
  }

  /* マージ後のプレビュー（3 つ目のペイン）。上の左右のグリッドと 3:2 で分ける */
  .preview-label {
    flex: 0 0 auto;
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 2px 8px;
    border-top: 2px solid var(--app-border-strong);
    background: var(--app-bg-raised);
    font-size: var(--app-font-size-mono);
    overflow: hidden;
    white-space: nowrap;
  }

  .preview-title {
    font-weight: 700;
    color: var(--app-text-secondary);
  }

  .legend {
    color: var(--app-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mark {
    margin-left: 6px;
    padding: 0 4px;
  }

  .mark.theirs {
    box-shadow: inset 0 0 0 2px var(--app-text-added);
  }

  .mark.edited {
    box-shadow: inset 0 0 0 2px var(--app-accent);
  }

  .mark.undecided {
    outline: 2px dashed var(--app-text-conflict);
    outline-offset: -2px;
  }

  .preview {
    flex: 2 1 0;
    display: grid;
    min-height: 0;
  }

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
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 2px 4px 2px 8px;
    background: var(--app-bg-raised);
    color: var(--app-text-secondary);
  }

  .grids {
    flex: 3 1 0;
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
