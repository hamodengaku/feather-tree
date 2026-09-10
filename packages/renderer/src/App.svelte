<script lang="ts">
  import { app } from './lib/appState.svelte.js';
  import BranchPane from './panes/BranchPane.svelte';
  import WorkingTreePane from './panes/WorkingTreePane.svelte';
  import DiffPane from './panes/DiffPane.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import CommandLogPanel from './components/CommandLogPanel.svelte';
  import PaneSplitter from './components/PaneSplitter.svelte';
  import OptionsDialog from './components/OptionsDialog.svelte';
  import CreateBranchDialog from './components/CreateBranchDialog.svelte';
  import FocusRefreshDialog from './components/FocusRefreshDialog.svelte';
  import { isDarkTheme } from './lib/theme.js';

  void app.initialize();

  const gitMissing = $derived(app.environment !== null && app.environment.gitPath === null);
  const counts = $derived(app.summary?.counts ?? null);

  // ---------------------------------------------------------------- center/diff の比率レイアウト

  let panesWidth = $state(0);
  let liveCenterWidth = $state<number | null>(null);
  let liveLeftWidth = $state<number | null>(null);

  /** ブランチペインを折り畳んだときに残す帯の幅。 */
  const BRANCH_STRIP_WIDTH = 28;

  const leftCollapsed = $derived(app.settings?.branchPaneCollapsed ?? false);
  const leftWidth = $derived(
    leftCollapsed ? BRANCH_STRIP_WIDTH : (liveLeftWidth ?? app.settings?.paneWidths.left ?? 260),
  );
  /** 折り畳み時はブランチ/中央の分割線ごと出さないので、その分の 6px も無い。 */
  const leftSplitterWidth = $derived(leftCollapsed ? 0 : 6);

  const ratio = $derived(app.settings?.paneWidths.centerRatio ?? 0.5);
  /** center + diff の合計トラック幅（左ペイン・その分割線・center/diff の分割線を除く）。 */
  const availableCD = $derived(Math.max(1, panesWidth - leftWidth - leftSplitterWidth - 6));
  const centerWidthPx = $derived(liveCenterWidth ?? Math.round(ratio * availableCD));

  /**
   * 通常時は fr 単位で比率だけを指定し、ウィンドウ伸縮に応じたブラウザ側の再配分に任せる
   * （center/diff がブランチペイン幅を保ったまま連動して伸縮し、diff は minmax で消えない）。
   * ドラッグ中だけ px 値に切り替え、PaneSplitter の col-resize の感触を保つ。
   */
  const gridColumns = $derived.by(() => {
    const left = leftCollapsed ? `${leftWidth}px` : `${leftWidth}px 6px`;
    const centerDiff =
      liveCenterWidth !== null
        ? `${liveCenterWidth}px 6px minmax(200px, 1fr)`
        : `minmax(160px, ${ratio}fr) 6px minmax(200px, ${1 - ratio}fr)`;
    return `${left} ${centerDiff}`;
  });

  function commitCenterWidth(nextPx: number): void {
    const nextRatio = nextPx / availableCD;
    liveCenterWidth = null;
    void app.setCenterRatio(nextRatio);
  }

  function commitLeftWidth(nextPx: number): void {
    liveLeftWidth = null;
    void app.setLeftWidth(nextPx);
  }

  // 既存ユーザーの移行: paneWidths.center（レガシー px）を、実測幅から比率へ一度だけ変換する。
  // 変換の瞬間は同じ px 値から計算するため見た目のジャンプは起きない。
  $effect(() => {
    if (app.settings === null || app.settings.paneWidths.centerRatio !== null) return;
    if (panesWidth === 0) return;
    void app.setCenterRatio(app.settings.paneWidths.center / availableCD);
  });

  // ---------------------------------------------------------------- タブのドラッグ並び替え

  let draggingId = $state<string | null>(null);

  function handleTabDragStart(id: string, event: DragEvent): void {
    draggingId = id;
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
  }

  function handleTabDragOver(overId: string, event: DragEvent): void {
    event.preventDefault();
    if (draggingId === null || draggingId === overId) return;
    const ids = app.sessions.map((s) => s.id);
    const from = ids.indexOf(draggingId);
    const to = ids.indexOf(overId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, draggingId);
    app.reorderTabs(ids);
  }

  function handleTabDragEnd(): void {
    draggingId = null;
    void app.commitTabOrder();
  }

  let optionsOpen = $state(false);
</script>

<div class="shell">
  <header class="titlebar">
    <div class="tabs" role="tablist">
      {#each app.sessions as session (session.id)}
        <div
          class="tab"
          class:active={session.id === app.activeId}
          class:dragging={session.id === draggingId}
          role="presentation"
          draggable="true"
          ondragstart={(e) => handleTabDragStart(session.id, e)}
          ondragover={(e) => handleTabDragOver(session.id, e)}
          ondragend={handleTabDragEnd}
        >
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
        title="設定"
        aria-haspopup="dialog"
        aria-expanded={optionsOpen}
        onclick={() => (optionsOpen = true)}
      >
        {isDarkTheme(app.settings?.theme ?? 'phoenix-light') ? '☾' : '☀'} ⚙
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
    <main class="panes" style:grid-template-columns={gridColumns} bind:clientWidth={panesWidth}>
      <BranchPane />
      {#if !leftCollapsed}
        <PaneSplitter
          value={leftWidth}
          min={120}
          max={1200}
          onchange={(w) => (liveLeftWidth = w)}
          oncommit={commitLeftWidth}
        />
      {/if}
      <WorkingTreePane />
      <PaneSplitter
        value={centerWidthPx}
        min={160}
        max={Math.max(160, availableCD - 200)}
        onchange={(w) => (liveCenterWidth = w)}
        oncommit={commitCenterWidth}
      />
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

<!--
  オーバーレイ（position: fixed のもの）は必ずここ、shell の外に置く。
  ペインの内側に置くと、DOM 上で後ろに来るペインが上に描画され、
  背後のペインがクリックやマウスオーバーを拾ってしまう。
  前後関係は tokens.css の --app-layer-* だけで決まる（この並び順には依存しない）。
-->
<ConfirmDialog />
<CreateBranchDialog />
<OptionsDialog open={optionsOpen} onclose={() => (optionsOpen = false)} />
<FocusRefreshDialog />

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

  .tab.dragging {
    opacity: 0.5;
  }

  .tab-label,
  .tab-close,
  .tab-add {
    background: none;
    border: none;
    padding: 3px 8px;
    white-space: nowrap;
  }

  .tab-label {
    cursor: grab;
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
