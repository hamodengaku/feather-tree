<script lang="ts">
  /*
   * コミットログモードの上半分（決定 27）。グラフ付きのコミットリスト。
   *
   * 履歴は**このペインが見えているときにだけ**取る。差分モードでいる限り #20 は走らない
   * （見えていないもののために git を起動しない）。
   */
  import { app } from '../lib/appState.svelte.js';
  import VirtualCommitList from '../components/VirtualCommitList.svelte';

  // モードに入った瞬間・タブを切り替えた瞬間に、まだ取っていなければ取る。
  // 取得済みならキャッシュを見せるだけで IPC は呼ばない（タブ切替の規約）。
  $effect(() => {
    void app.activeId;
    void app.ensureLog();
  });
</script>

<div class="pane commit-log-pane">
  <header>
    <h2>コミットログ</h2>
    <span class="meta">
      {#if app.commits.length > 0}
        {app.commits.length} 件{app.logComplete ? '（すべて）' : ''}
      {/if}
    </span>
    <button
      class="reload"
      disabled={app.busy || app.logLoading || app.activeId === null}
      title="履歴だけを取り直す（git log）"
      onclick={() => void app.loadLog()}
    >
      再読み込み
    </button>
  </header>

  {#if app.activeId === null}
    <p class="empty">リポジトリを開くと履歴を表示します。</p>
  {:else if app.commits.length === 0}
    <p class="empty">{app.logLoading ? '読み込み中…' : 'コミットがありません。'}</p>
  {:else}
    <VirtualCommitList
      commits={app.commits}
      branches={app.branches}
      selectedOid={app.selectedCommit}
      complete={app.logComplete}
      loading={app.logLoading}
      onselect={(oid) => void app.selectCommit(oid)}
      onneedmore={() => void app.loadMoreLog()}
    />
  {/if}
</div>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--app-metric-gap);
    padding: 6px 8px;
    background: var(--app-bg-surface);
    border-bottom: 1px solid var(--app-border-subtle);
  }

  h2 {
    margin: 0;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
    white-space: nowrap;
  }

  .meta {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .reload {
    flex: 0 0 auto;
    font-size: var(--app-font-size-mono);
    padding: 1px 8px;
  }

  .empty {
    margin: 16px;
    color: var(--app-text-muted);
  }
</style>
