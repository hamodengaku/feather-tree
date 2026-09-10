<script lang="ts">
  import type { BranchDto } from '@feathertree/ipc';
  import { ft } from '../bridge.js';
  import { app } from '../lib/appState.svelte.js';
  import PaneSplitter from '../components/PaneSplitter.svelte';

  let branches = $state<BranchDto[]>([]);

  let liveLocalHeight = $state<number | null>(null);
  const localHeight = $derived(liveLocalHeight ?? app.settings?.branchLocalHeight ?? 180);

  function commitLocalHeight(next: number): void {
    liveLocalHeight = null;
    void app.setBranchLocalHeight(next);
  }

  /** ドラッグの上限。リモート側に最低 40px は残す。 */
  let listsHeight = $state(0);
  const maxLocalHeight = $derived(Math.max(80, listsHeight - 40));

  const collapsed = $derived(app.settings?.branchPaneCollapsed ?? false);

  // ブランチ一覧は status とは別に保持する。切替・作成・削除の実装は Phase 6。
  $effect(() => {
    const id = app.activeId;
    if (id === null) {
      branches = [];
      return;
    }
    void ft.branchList(id).then((result) => {
      if (result.ok) branches = [...result.value];
    });
  });

  const locals = $derived(branches.filter((b) => !b.isRemote));
  const remotes = $derived(branches.filter((b) => b.isRemote));
  const head = $derived(app.summary?.head ?? null);
</script>

{#if collapsed}
  <div class="strip">
    <button
      class="expand-btn"
      title="ブランチペインを開く"
      onclick={() => void app.setBranchPaneCollapsed(false)}
    >
      ›
    </button>
  </div>
{:else}
<div class="pane">
  <section>
    <div class="head-header">
      <h2>現在の位置</h2>
      <button
        class="collapse-btn"
        title="ブランチペインを閉じる"
        onclick={() => void app.setBranchPaneCollapsed(true)}
      >
        ‹
      </button>
    </div>
    {#if head === null}
      <p class="empty">リポジトリを開いてください。</p>
    {:else}
      <div class="head">
        <div class="branch-name">{head.detached ? 'detached HEAD' : (head.branch ?? '(不明)')}</div>
        {#if head.oid === null}
          <div class="sub">コミットがまだありません</div>
        {:else}
          <div class="sub mono">{head.oid.slice(0, 8)}</div>
        {/if}
        {#if head.upstream !== null}
          <div class="sub">
            {head.upstream}
            {#if head.ahead > 0}<span class="ahead">↑{head.ahead}</span>{/if}
            {#if head.behind > 0}<span class="behind">↓{head.behind}</span>{/if}
          </div>
        {/if}
      </div>
    {/if}
  </section>

  <div class="lists" style:grid-template-rows="{localHeight}px 6px 1fr" bind:clientHeight={listsHeight}>
    <section class="list">
      <h2>ローカル <span class="count">{locals.length}</span></h2>
      <ul>
        {#each locals as branch (branch.refName)}
          <li class:current={branch.isHead}>
            <span class="dot">{branch.isHead ? '●' : ''}</span>
            <span class="name" title={branch.subject}>{branch.shortName}</span>
            {#if branch.ahead > 0}<span class="ahead">↑{branch.ahead}</span>{/if}
            {#if branch.behind > 0}<span class="behind">↓{branch.behind}</span>{/if}
            {#if branch.gone}<span class="gone">gone</span>{/if}
          </li>
        {/each}
      </ul>
    </section>

    <PaneSplitter
      axis="y"
      value={localHeight}
      min={80}
      max={maxLocalHeight}
      onchange={(h) => (liveLocalHeight = h)}
      oncommit={commitLocalHeight}
    />

    <section class="list">
      <h2>リモート <span class="count">{remotes.length}</span></h2>
      <ul>
        {#each remotes as branch (branch.refName)}
          <li>
            <span class="dot"></span>
            <span class="name" title={branch.subject}>{branch.shortName}</span>
          </li>
        {/each}
      </ul>
    </section>
  </div>
</div>
{/if}

<style>
  .pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    border-right: 1px solid var(--app-border-subtle);
    overflow: hidden;
  }

  section {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-bottom: 1px solid var(--app-border-subtle);
  }

  .lists {
    display: grid;
    flex: 1 1 auto;
    min-height: 0;
  }

  section.list {
    min-height: 0;
    overflow: hidden;
  }

  h2 {
    margin: 0;
    padding: 6px 8px;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
    color: var(--app-text-secondary);
    background: var(--app-bg-surface);
    border-bottom: 1px solid var(--app-border-subtle);
  }

  .head-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--app-bg-surface);
    border-bottom: 1px solid var(--app-border-subtle);
  }

  .head-header h2 {
    padding: 6px 0 6px 8px;
    background: none;
    border-bottom: none;
  }

  .collapse-btn,
  .expand-btn {
    flex: 0 0 auto;
    background: none;
    border: none;
    color: var(--app-text-secondary);
    cursor: pointer;
    font-size: calc(var(--app-font-size-ui) * 2);
    line-height: 1;
  }

  .collapse-btn {
    margin-right: 4px;
    padding: 4px 8px;
  }

  .collapse-btn:hover,
  .expand-btn:hover {
    color: var(--app-text-primary);
    background: var(--app-bg-hover);
  }

  .strip {
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 100%;
    border-right: 1px solid var(--app-border-subtle);
    background: var(--app-bg-surface);
  }

  .expand-btn {
    margin-top: 4px;
    padding: 6px 4px;
  }

  .count {
    color: var(--app-text-muted);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .head {
    padding: 8px;
  }

  .branch-name {
    font-weight: 600;
  }

  .sub {
    margin-top: 2px;
    color: var(--app-text-secondary);
    font-size: var(--app-font-size-mono);
  }

  .mono {
    font-family: var(--app-font-mono);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-y: auto;
    min-height: 0;
  }

  li {
    display: flex;
    align-items: center;
    gap: 5px;
    height: var(--app-metric-row-height);
    padding: 0 8px;
    white-space: nowrap;
  }

  li:hover {
    background: var(--app-bg-hover);
  }

  li.current {
    font-weight: 600;
  }

  .dot {
    flex: 0 0 auto;
    width: 10px;
    color: var(--app-accent);
    font-size: 9px;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ahead {
    color: var(--app-text-added);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .behind {
    color: var(--app-text-modified);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .gone {
    color: var(--app-text-danger);
    font-size: var(--app-font-size-mono);
  }

  .empty {
    margin: 8px;
    color: var(--app-text-muted);
  }
</style>
