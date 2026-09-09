<script lang="ts">
  import { app } from './lib/appState.svelte.js';
  import BranchPane from './panes/BranchPane.svelte';
  import WorkingTreePane from './panes/WorkingTreePane.svelte';
  import DiffPane from './panes/DiffPane.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import CommandLogPanel from './components/CommandLogPanel.svelte';

  void app.initialize();

  const gitMissing = $derived(app.environment !== null && app.environment.gitPath === null);
  const counts = $derived(app.summary?.counts ?? null);
</script>

<div class="shell">
  <header class="titlebar">
    <div class="tabs" role="tablist">
      {#each app.sessions as session (session.id)}
        <div class="tab" class:active={session.id === app.activeId} role="presentation">
          <button
            class="tab-label"
            role="tab"
            aria-selected={session.id === app.activeId}
            title={session.root}
            onclick={() => void app.activate(session.id)}
          >
            {session.displayName}
          </button>
          <button class="tab-close" title="閉じる" onclick={() => void app.closeTab(session.id)}>×</button>
        </div>
      {/each}
      <button class="tab-add" title="リポジトリを開く" onclick={() => void app.openRepository()}>＋</button>
    </div>

    <div class="toolbar">
      {#if counts !== null}
        <span class="counts">
          <span class="staged">{counts.staged}</span>
          /
          <span class="changed">{counts.unstaged + counts.untracked + counts.unmerged}</span>
        </span>
      {/if}
      <button disabled={app.busy || app.activeId === null} onclick={() => void app.refresh('full')}>更新</button>
      <button onclick={() => (app.showCommandLog = !app.showCommandLog)}>ログ</button>
      <button
        onclick={() => void app.setTheme(app.settings?.theme === 'light' ? 'dark' : 'light')}
        title="テーマ切替"
      >
        {app.settings?.theme === 'light' ? '☀' : '☾'}
      </button>
    </div>
  </header>

  {#if app.environment?.warning != null}
    <div class="banner">{app.environment.warning}</div>
  {/if}

  {#if gitMissing}
    <div class="center">
      <div class="notice">
        <h1>git が見つかりません</h1>
        <p>FeatherTree は Git for Windows の git.exe を利用します。</p>
        <p class="mono">https://git-scm.com/download/win</p>
        <p>導入後にアプリを再起動するか、設定で git.exe のパスを指定してください。</p>
      </div>
    </div>
  {:else if app.sessions.length === 0}
    <div class="center">
      <div class="notice">
        <h1>FeatherTree</h1>
        <p>リポジトリを開いて開始します。</p>
        <button onclick={() => void app.openRepository()}>リポジトリを開く</button>
      </div>
    </div>
  {:else}
    <main
      class="panes"
      style:grid-template-columns="{app.settings?.paneWidths.left ?? 260}px {app.settings?.paneWidths
        .center ?? 420}px 1fr"
    >
      <BranchPane />
      <WorkingTreePane />
      <DiffPane />
    </main>
  {/if}

  {#if app.showCommandLog}
    <CommandLogPanel />
  {/if}

  {#if app.error !== null}
    <div class="error" role="alert">
      <div class="error-body">
        <strong>{app.error.message}</strong>
        {#if app.error.detail !== undefined}
          <pre>{app.error.detail}</pre>
        {/if}
      </div>
      <button onclick={() => app.dismissError()}>閉じる</button>
    </div>
  {/if}
</div>

<ConfirmDialog />

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .titlebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-metric-gap);
    padding: 4px 8px;
    background: var(--app-bg-surface);
    border-bottom: 1px solid var(--app-border-subtle);
  }

  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
    min-width: 0;
  }

  .tab {
    display: flex;
    align-items: center;
    border: 1px solid transparent;
    border-radius: var(--app-metric-radius);
  }

  .tab.active {
    background: var(--app-bg-selected);
    border-color: var(--app-border-strong);
  }

  .tab-label,
  .tab-close,
  .tab-add {
    background: none;
    border: none;
    padding: 3px 8px;
    white-space: nowrap;
  }

  .tab-close {
    padding: 3px 6px;
    color: var(--app-text-muted);
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }

  .counts {
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    color: var(--app-text-muted);
  }

  .counts .staged {
    color: var(--app-text-added);
  }

  .counts .changed {
    color: var(--app-text-modified);
  }

  .banner {
    padding: 5px 10px;
    background: var(--app-bg-raised);
    border-bottom: 1px solid var(--app-border-subtle);
    color: var(--app-text-conflict);
    font-size: var(--app-font-size-mono);
  }

  .panes {
    flex: 1 1 auto;
    display: grid;
    min-height: 0;
  }

  .center {
    flex: 1 1 auto;
    display: grid;
    place-items: center;
  }

  .notice {
    text-align: center;
    max-width: 460px;
  }

  .notice h1 {
    margin: 0 0 12px;
    font-size: 20px;
  }

  .notice p {
    margin: 6px 0;
    color: var(--app-text-secondary);
  }

  .notice .mono {
    font-family: var(--app-font-mono);
    color: var(--app-accent);
  }

  .error {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--app-metric-gap);
    padding: 8px 10px;
    background: var(--app-bg-raised);
    border-top: 1px solid var(--app-text-danger);
  }

  .error-body {
    min-width: 0;
  }

  .error strong {
    color: var(--app-text-danger);
  }

  .error pre {
    margin: 6px 0 0;
    max-height: 120px;
    overflow: auto;
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    color: var(--app-text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
