<script lang="ts">
  /*
   * コンポーネント差分ペイン（決定 32 / 要件 8・13）。
   *
   * 列は「変数 / 変更前 / 変更後」。**全変数を出して変更行だけ強調**し、
   * 未変更行は 2 列を結合して値を 1 回だけ弱色で出す。
   *
   * ボタンは通常モードの置き換え:
   *   hunk ステージ  → 「コンポーネントをステージ」（見出しの右）
   *   1 行ステージ   → 「1 パラメータだけステージ」（行の右）
   * ステージ済みのファイルを見ているときは、どちらも「アンステージ」になる。
   *
   * **`<table>` は使わない。** 未変更行の 2 列結合を colspan でやると、行数が数千に
   * なったときに仮想化と両立しない。grid なら `grid-column: span 2` で同じ見た目になる。
   */
  import { app } from '../lib/appState.svelte.js';
  import { adoptedSide, conflictEntryIndex, isConflictNode, unityColumnLabels } from '../lib/unityConflict.js';
  import type { UnityRowDto } from '@feathertree/ipc';

  const detail = $derived(app.unityNode);
  const view = $derived(app.unityView);
  const staged = $derived(view?.staged ?? false);
  // 未マージなら 変更前 / 変更後 ではなく 自分側 / 相手側
  const columns = $derived(unityColumnLabels(view?.conflict ?? null));
  /*
   * 未マージ（2026-10-10）。決まるまでは自分側と相手側を対等に出す（斜線を引かない）。
   * 決まったら（選んだ・自動で決まった）採用側を強調し、棄却側に斜線を引く。
   */
  const conflict = $derived(view?.conflict ?? null);
  const conflictIndex = $derived(conflictEntryIndex(conflict));
  const adopted = $derived(
    detail === null ? null : adoptedSide(conflict, conflictIndex, app.unityChoices, detail.nodeId),
  );
  // 両側が変えた衝突のノードなら、変わった行を強調色（コンフリ色）で出す
  const conflictNode = $derived(detail === null ? false : isConflictNode(conflict, conflictIndex, detail.nodeId));
  const actionLabel = $derived(staged ? 'アンステージ' : 'ステージ');

  /*
   * 列幅の変更（2026-10-10）。見出しの縦線を掴んで動かす。本体の行には縦線を出さない。
   * 3 列目は残り全部（minmax(0, 1fr)）。
   */
  const COLUMN_MIN = 60;
  const COLUMN_MAX = 1200;
  let resizing: { column: 'key' | 'old'; startX: number; startWidth: number } | null = null;

  function startResize(event: PointerEvent, column: 'key' | 'old'): void {
    const startWidth = column === 'key' ? app.unityKeyColumnWidth : app.unityOldColumnWidth;
    resizing = { column, startX: event.clientX, startWidth };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function moveResize(event: PointerEvent): void {
    if (resizing === null) return;
    const width = Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, resizing.startWidth + event.clientX - resizing.startX));
    if (resizing.column === 'key') app.unityKeyColumnWidth = width;
    else app.unityOldColumnWidth = width;
  }

  function endResize(event: PointerEvent): void {
    if (resizing === null) return;
    resizing = null;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }

  /** 選択中のノードの名前（見出しに出す）。 */
  const nodeName = $derived(
    view?.nodes.find((n) => n.id === app.unitySelectedNode)?.name ?? '',
  );

  const nodeSelection = $derived(detail?.selection ?? null);

  /**
   * その 1 行のボタンの説明。
   *
   * 同じ行に別の変更が乗っているときは**押す前に分かるようにする**——
   * git が扱えるのは行までなので、`{x: 2, y: 3, z: 1}` の x だけを入れることはできない。
   */
  function rowTitle(row: UnityRowDto): string {
    const base = '1 パラメータだけ' + actionLabel;
    if (row.alsoStages === 0) return base;
    return (
      base +
      '（同じ行に他の変更が ' +
      String(row.alsoStages) +
      ' 件あるため、それらも一緒に入ります）'
    );
  }
</script>

<div class="unity-property-pane">
  <div class="head">
    <span class="title">{nodeName === '' ? 'コンポーネント差分' : nodeName}</span>
    {#if nodeSelection !== null}
      <button
        class="node-stage"
        type="button"
        title="このノードの変更をまとめて{actionLabel}します（配下のコンポーネントは含みません）"
        onclick={() => void app.applyUnitySelection(nodeSelection)}
        >コンポーネントを{actionLabel}</button
      >
    {/if}
  </div>

  {#if app.unitySelectedNode === null}
    <p class="empty">左でゲームオブジェクトかコンポーネントを選んでください。</p>
  {:else if app.unityNodeLoading && detail === null}
    <p class="empty">読み込み中…</p>
  {:else if detail === null || detail.rows.length === 0}
    <p class="empty">表示できる変数がありません。</p>
  {:else}
    <div
      class="table"
      class:conflict-mode={conflict !== null}
      class:adopt-ours={adopted === 'ours'}
      class:adopt-theirs={adopted === 'theirs'}
      class:conflict-node={conflictNode}
      style:--col-key="{app.unityKeyColumnWidth}px"
      style:--col-old="{app.unityOldColumnWidth}px"
      role="table"
      aria-label="コンポーネントの差分"
    >
      <div class="thead" role="row">
        <span role="columnheader" class="th">
          変数
          <span
            class="resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="変数の列の幅"
            onpointerdown={(event) => startResize(event, 'key')}
            onpointermove={moveResize}
            onpointerup={endResize}
          ></span>
        </span>
        <span role="columnheader" class="th">
          {columns[0]}
          <span
            class="resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="{columns[0]}の列の幅"
            onpointerdown={(event) => startResize(event, 'old')}
            onpointermove={moveResize}
            onpointerup={endResize}
          ></span>
        </span>
        <span role="columnheader" class="th">{columns[1]}</span>
        <span role="columnheader" class="sr-only">操作</span>
      </div>

      {#each detail.rows as row (row.key)}
        <div
          class="tr {row.state}"
          role="row"
          title={row.state === 'same' ? '' : '変更あり'}
        >
          <span class="key" role="cell" title={row.key}>{row.key}</span>

          {#if row.state === 'same'}
            <!-- 未変更行は 2 列を結合して値を 1 回だけ、弱色で出す（要件 8） -->
            <span class="value same" role="cell">{row.after ?? ''}</span>
          {:else}
            <span class="value before" role="cell">{row.before ?? ''}</span>
            <span class="value after" role="cell">{row.after ?? ''}</span>
          {/if}

          <span class="ops" role="cell">
            {#if row.selection !== null}
              <button
                class="row-stage"
                type="button"
                title={rowTitle(row)}
                onclick={() => void app.applyUnitySelection(row.selection)}
              >
                1 パラメータだけ{actionLabel}{row.alsoStages > 0 ? ' ⚠' : ''}
              </button>
            {/if}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .unity-property-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--app-border-subtle);
    background: var(--app-bg-raised);
  }

  .title {
    font-size: var(--app-font-size-ui);
    color: var(--app-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .node-stage {
    margin-left: auto;
    flex: 0 0 auto;
    font-size: calc(var(--app-font-size-ui) * 0.9);
  }

  .empty {
    margin: 0;
    padding: 12px;
    color: var(--app-text-secondary);
    font-size: var(--app-font-size-ui);
  }

  .table {
    flex: 1 1 auto;
    overflow: auto;
    min-height: 0;
    font-size: var(--app-font-size-ui);
  }

  /*
    変数 / 変更前 / 変更後。**列の幅は全行で同じ値**（見出しの縦線で変える）。
    以前は行ごとの grid に操作ボタンの列（auto）があり、ボタンの有無で行ごとに列幅が変わって
    縦列が乱れていた。操作ボタンは列から外して行の右端に重ねる（.ops）。
  */
  .thead,
  .tr {
    position: relative;
    display: grid;
    grid-template-columns: var(--col-key) var(--col-old) minmax(0, 1fr);
    align-items: baseline;
    gap: 8px;
    padding: 2px 8px;
  }

  .th {
    position: relative;
    min-width: 0;
    overflow: visible;
    white-space: nowrap;
  }

  /* 見出しの縦線。列の右端（gap の真ん中）に置き、掴んで幅を変える */
  .resizer {
    position: absolute;
    top: -2px;
    bottom: -2px;
    right: -7px;
    width: 6px;
    cursor: col-resize;
    touch-action: none;
  }

  .resizer::after {
    content: '';
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 2px;
    width: 1px;
    background: var(--app-border-subtle);
  }

  .resizer:hover::after {
    background: var(--app-accent);
  }

  .thead {
    position: sticky;
    top: 0;
    background: var(--app-bg-raised);
    border-bottom: 1px solid var(--app-border-subtle);
    color: var(--app-text-secondary);
  }

  .tr:hover {
    background: var(--app-bg-hover);
  }

  .key {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--app-text-primary);
  }

  .value {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--app-font-mono);
  }

  /* 未変更行。2 列ぶんに広げて値を 1 回だけ、弱色で出す。 */
  .value.same {
    grid-column: span 2;
    color: var(--app-text-secondary);
  }

  .value.before {
    color: var(--app-text-secondary);
    text-decoration: line-through;
  }

  /* 変更後は強調色（要件 8）。 */
  .value.after {
    color: var(--app-text-modified);
  }

  .tr.added .value.after {
    color: var(--app-text-added);
  }

  .tr.removed .value.before {
    color: var(--app-text-removed);
  }

  /* 未マージ: 決まるまでは対等（同じ色・斜線なし） */
  .table.conflict-mode .value.before,
  .table.conflict-mode .tr .value.after {
    color: var(--app-text-modified);
    text-decoration: none;
  }

  /* 決まったら採用側を強調、棄却側に斜線 */
  .table.conflict-mode.adopt-ours .value.before,
  .table.conflict-mode.adopt-theirs .tr .value.after {
    font-weight: 700;
  }

  .table.conflict-mode.adopt-ours .tr .value.after,
  .table.conflict-mode.adopt-theirs .value.before {
    color: var(--app-text-secondary);
    font-weight: 400;
    text-decoration: line-through;
  }

  .tr.changed,
  .tr.added,
  .tr.removed {
    background: var(--app-diff-added-bg);
  }

  .tr.removed {
    background: var(--app-diff-removed-bg);
  }

  /*
    衝突（両側が変えた）ノードの変わった行は、変数名・自分側・相手側をすべてコンフリ色にし、
    行の色も追加（緑）・削除（赤）とは別のコンフリ色にする（2026-10-10、利用者の指示）。
    背景はテーマの --app-text-conflict を薄めて作る（テーマに色を足さない）。
  */
  .table.conflict-node .tr:not(.same) {
    background: color-mix(in srgb, var(--app-text-conflict) 14%, transparent);
  }

  .table.conflict-node .tr:not(.same) .key,
  .table.conflict-node .tr:not(.same) .value.before,
  .table.conflict-node .tr:not(.same) .value.after {
    color: var(--app-text-conflict);
  }

  /* 採用・棄却が決まったら、棄却側は斜線＋弱色（コンフリ色より優先） */
  .table.conflict-node.adopt-ours .tr:not(.same) .value.after,
  .table.conflict-node.adopt-theirs .tr:not(.same) .value.before {
    color: var(--app-text-secondary);
  }

  /* 操作ボタンは列に入れず、行の右端に重ねる（列幅を行ごとに変えないため） */
  .ops {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 8px;
    display: flex;
    align-items: center;
  }

  .row-stage {
    background: var(--app-bg-raised);
  }

  /*
    ボタンは既定では出さず、その行に触れたときだけ出す。
    数千行に常時ボタンが並ぶと、肝心の値が読めなくなる（DiffPane の hunk ボタンと同じ考え方）。
  */
  .row-stage {
    visibility: hidden;
    font-size: calc(var(--app-font-size-ui) * 0.85);
    white-space: nowrap;
  }

  .tr:hover .row-stage,
  .tr:focus-within .row-stage {
    visibility: visible;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
