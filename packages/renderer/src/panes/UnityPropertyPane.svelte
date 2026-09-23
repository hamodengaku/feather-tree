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
  import type { UnityRowDto } from '@feathertree/ipc';

  const detail = $derived(app.unityNode);
  const view = $derived(app.unityView);
  const staged = $derived(view?.staged ?? false);
  const actionLabel = $derived(staged ? 'アンステージ' : 'ステージ');

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
    <div class="table" role="table" aria-label="コンポーネントの差分">
      <div class="thead" role="row">
        <span role="columnheader">変数</span>
        <span role="columnheader">変更前</span>
        <span role="columnheader">変更後</span>
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

  .thead,
  .tr {
    display: grid;
    /* 変数 / 変更前 / 変更後 / 操作 */
    grid-template-columns: minmax(140px, 1.2fr) minmax(80px, 1fr) minmax(80px, 1fr) auto;
    align-items: baseline;
    gap: 8px;
    padding: 2px 8px;
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--app-text-primary);
  }

  .value {
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

  .tr.changed,
  .tr.added,
  .tr.removed {
    background: var(--app-diff-added-bg);
  }

  .tr.removed {
    background: var(--app-diff-removed-bg);
  }

  .ops {
    min-width: 0;
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
