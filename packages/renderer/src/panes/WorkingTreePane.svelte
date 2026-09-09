<script lang="ts">
  import type { FileEntryDto } from '@feathertree/ipc';
  import { app } from '../lib/appState.svelte.js';
  import VirtualFileList from '../components/VirtualFileList.svelte';

  const stagedCount = $derived(app.summary?.counts.staged ?? 0);
  const changesTotal = $derived(app.changes.total);

  function select(entry: FileEntryDto, staged: boolean): void {
    void app.select({ path: entry.path, staged });
  }
</script>

<div class="pane">
  <section class="group">
    <header>
      <h2>ステージ済み <span class="count">{stagedCount}</span></h2>
      <div class="actions">
        <button disabled={app.busy || stagedCount === 0} onclick={() => void app.unstage({ kind: 'filtered', filter: { group: 'staged' } })}>
          すべて戻す
        </button>
      </div>
    </header>
    <VirtualFileList
      group="staged"
      entries={app.staged.entries}
      total={app.staged.total}
      selectedPath={app.selected?.staged === true ? app.selected.path : null}
      onselect={(entry) => select(entry, true)}
      onneedpage={(offset) => void app.loadMore('staged', offset)}
    />
  </section>

  <section class="group">
    <header>
      <h2>変更 <span class="count">{changesTotal}</span></h2>
      <div class="actions">
        <button
          disabled={app.busy || changesTotal === 0}
          onclick={() => void app.stage({ kind: 'filtered', filter: { group: 'changes' } })}
        >
          すべてステージ
        </button>
        <button
          class="danger"
          disabled={app.busy || changesTotal === 0}
          onclick={() => void app.discard({ kind: 'filtered', filter: { group: 'unstaged' } })}
        >
          変更を破棄
        </button>
        <button
          class="danger"
          disabled={app.busy || (app.summary?.counts.untracked ?? 0) === 0}
          onclick={() => void app.deleteUntracked({ kind: 'filtered', filter: { group: 'untracked' } })}
        >
          未追跡を削除
        </button>
      </div>
    </header>
    <VirtualFileList
      group="changes"
      entries={app.changes.entries}
      total={app.changes.total}
      selectedPath={app.selected?.staged === false ? app.selected.path : null}
      onselect={(entry) => select(entry, false)}
      onneedpage={(offset) => void app.loadMore('changes', offset)}
    />
  </section>

  <section class="commit">
    <textarea
      bind:value={app.commitMessage}
      placeholder="コミットメッセージ"
      rows="4"
      spellcheck="false"
    ></textarea>
    <div class="commit-actions">
      <label>
        <input type="checkbox" bind:checked={app.amend} />
        直前のコミットを修正
      </label>
      <button disabled={!app.canCommit} onclick={() => void app.commit()}>コミット</button>
    </div>
  </section>
</div>

<style>
  .pane {
    display: grid;
    grid-template-rows: 1fr 1fr auto;
    min-height: 0;
    height: 100%;
    border-right: 1px solid var(--app-border-subtle);
  }

  .group {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-bottom: 1px solid var(--app-border-subtle);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-metric-gap);
    padding: 6px 8px;
    background: var(--app-bg-surface);
    border-bottom: 1px solid var(--app-border-subtle);
  }

  h2 {
    margin: 0;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
    color: var(--app-text-secondary);
    white-space: nowrap;
  }

  .count {
    color: var(--app-text-muted);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .actions {
    display: flex;
    gap: 4px;
  }

  .actions button {
    font-size: var(--app-font-size-mono);
    padding: 2px 8px;
  }

  .commit {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    background: var(--app-bg-surface);
  }

  .commit textarea {
    resize: vertical;
    min-height: 60px;
  }

  .commit-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .commit-actions label {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--app-text-secondary);
  }
</style>
