<script lang="ts">
  import { app } from './lib/appState.svelte.js';
  import { branchLeaf, truncateSubject } from './lib/tabLabel.js';
  import BranchPane from './panes/BranchPane.svelte';
  import WorkingTreePane from './panes/WorkingTreePane.svelte';
  import DiffPane from './panes/DiffPane.svelte';
  import CommitLogPane from './panes/CommitLogPane.svelte';
  import CommitDetailPane from './panes/CommitDetailPane.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import CommandLogPanel from './components/CommandLogPanel.svelte';
  import PaneSplitter from './components/PaneSplitter.svelte';
  import AppIcon from './components/AppIcon.svelte';
  import ActivityBar from './components/ActivityBar.svelte';
  import CommandBar from './components/CommandBar.svelte';
  import RemoteActions from './components/RemoteActions.svelte';
  import OptionsDialog from './components/OptionsDialog.svelte';
  import CreateBranchDialog from './components/CreateBranchDialog.svelte';
  import PushDialog from './components/PushDialog.svelte';
  import FocusRefreshDialog from './components/FocusRefreshDialog.svelte';
  import MottoDialog from './components/MottoDialog.svelte';

  void app.initialize();

  const gitMissing = $derived(app.environment !== null && app.environment.gitPath === null);

  // ---------------------------------------------------------------- center/diff の比率レイアウト

  let panesWidth = $state(0);
  let liveCenterWidth = $state<number | null>(null);
  let liveLeftWidth = $state<number | null>(null);

  const leftCollapsed = $derived(app.settings?.branchPaneCollapsed ?? false);
  /**
   * 折り畳み時はブランチペインごと出さない（幅ゼロ）。
   * 畳んだペインを呼び戻す口は縦帯（ActivityBar）が常に持っているので、
   * ここに帯を残す必要が無い。
   */
  const leftWidth = $derived(
    leftCollapsed ? 0 : (liveLeftWidth ?? app.settings?.paneWidths.left ?? 260),
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
    const centerDiff =
      liveCenterWidth !== null
        ? `${liveCenterWidth}px 6px minmax(200px, 1fr)`
        : `minmax(160px, ${ratio}fr) 6px minmax(200px, ${1 - ratio}fr)`;
    return leftCollapsed ? centerDiff : `${leftWidth}px 6px ${centerDiff}`;
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

  // ---------------------------------------------------------------- コミットログモードの上下分割

  /**
   * ペイン領域のモード（決定 27）。
   *
   * **ブランチペインは 2 つのモードで共通**で、左に居続ける（幅も折り畳み状態も同じ設定）。
   * モードが替えるのはその右側だけで、差分モードは左右 2 分割（作業ツリー / 差分）、
   * コミットログモードは上下 2 分割（コミットリスト / コミット詳細）になる。
   */
  const logMode = $derived(app.viewMode === 'log');

  /** コミットログモードの列。ブランチペインの扱いは差分モードとまったく同じ。 */
  const logColumns = $derived(
    leftCollapsed ? 'minmax(0, 1fr)' : `${leftWidth}px 6px minmax(0, 1fr)`,
  );

  let liveDetailHeight = $state<number | null>(null);
  const detailHeight = $derived(liveDetailHeight ?? app.settings?.logDetailHeight ?? 260);
  const logRows = $derived(`minmax(80px, 1fr) 6px ${String(detailHeight)}px`);

  function commitDetailHeight(nextPx: number): void {
    liveDetailHeight = null;
    void app.setLogDetailHeight(nextPx);
  }

  // ---------------------------------------------------------------- タブのラベル（決定 24）

  /**
   * タブに現在情報（ブランチ名と HEAD の件名）を出すか。
   *
   * **出せるのはアクティブなタブだけ。** 非アクティブなタブの状態を知るには git を走らせる
   * ことになり、「起動時に全リポジトリの状態を先読みしない（アクティブなタブのみ）」に反する
   * （docs/00-decisions.md「やらないこと」）。
   */
  const tabInfo = $derived(app.settings?.tabShowCurrentInfo ?? true);

  /** タブの丸に出すブランチ名（スラッシュの最終セグメントだけ）。 */
  const tabBranch = $derived.by(() => {
    const head = app.summary?.head ?? null;
    if (head === null) return null;
    if (head.detached) return 'detached';
    return head.branch === null ? null : branchLeaf(head.branch);
  });

  /** タブに出す件名。10 文字で打ち切る（全文は title で読める）。 */
  const tabSubject = $derived(
    app.headSubject === null ? null : truncateSubject(app.headSubject),
  );

  /** タブの title（ツールチップ）。省略した情報はすべてここで読めるようにする。 */
  function tabTitle(root: string): string {
    const head = app.summary?.head ?? null;
    if (!tabInfo || head === null) return root;
    const lines = [root];
    if (head.detached) lines.push('detached HEAD');
    else if (head.branch !== null) lines.push(head.branch);
    if (app.headSubject !== null) lines.push(app.headSubject);
    return lines.join('\n');
  }

  let optionsOpen = $state(false);
  /** ようこそ画面の銘を押したときに出る、出典を見せるだけのダイアログ。 */
  let mottoOpen = $state(false);
</script>

<div class="shell">
  <!--
    アプリヘッダ（決定 24）。上が「タブ段」、下が「ツールバー段」。
    タブ段は旧 OS ウィンドウ枠の位置に座り、ウィンドウのドラッグ領域を兼ねる。
    中の対話要素には必ず -webkit-app-region: no-drag を付けること
    （付け忘れると押下が OS のウィンドウ移動に吸われ、クリックも DnD も効かなくなる）。
  -->
  <header class="app-header">
    <div class="tabbar">
      <AppIcon />
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
              title={session.id === app.activeId ? tabTitle(session.root) : session.root}
              onclick={() => void app.activate(session.id)}
            >
              <span class="tab-repo">{session.displayName}</span>
              <!--
                現在情報はアクティブなタブだけ（他のタブの状態は手元に無い）。
                ブランチ名の丸はコミットログペインの名札（CommitRow の .ref）と同じ見え方。
              -->
              {#if tabInfo && session.id === app.activeId}
                {#if tabBranch !== null}
                  <span class="tab-branch">{tabBranch}</span>
                {/if}
                {#if tabSubject !== null}
                  <span class="tab-subject">{tabSubject}</span>
                {/if}
              {/if}
            </button>
            <button class="tab-close" title="閉じる" onclick={() => void app.closeTab(session.id)}>×</button>
          </div>
        {/each}
        <button class="tab-add" title="リポジトリを開く" onclick={() => void app.openRepository()}>＋</button>
      </div>

      <!--
        残り幅を埋めるだけの帯。ここを掴んでウィンドウを動かし、ダブルクリックで最大化する。
        右端のキャプション領域（OS が描く ─ □ ×）の分は .tabbar の padding-right で空けている。
      -->
      <div class="drag-spacer"></div>
    </div>

    <div class="toolbar">
      <!-- 左: リポジトリに効くもの -->
      <div class="toolbar-group">
        <button disabled={app.busy || app.activeId === null} onclick={() => void app.refresh('full')}>更新</button>
        <RemoteActions />
      </div>

      <!-- 中: 余剰幅すべて。実行中の git コマンド／ターミナルを開く口（決定 26） -->
      <CommandBar />

      <!-- 右: アプリ全体に効くもの（設定は縦帯の下端） -->
      <div class="toolbar-group">
        <button onclick={() => (app.showCommandLog = !app.showCommandLog)}>ログ</button>
      </div>
    </div>
  </header>

  <!--
    アプリヘッダより下は、左に縦帯（常設）、右に本体。
    警告帯・コマンドログ・エラー帯も本体側に入れる（縦帯はそれらより下まで通す）。
  -->
  <div class="body">
    <ActivityBar {optionsOpen} onopenoptions={() => (optionsOpen = true)} />

    <div class="body-main">
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
            <AppIcon size={64} />
            <h1>FeatherTree</h1>
            <!-- 「巨人の肩の上に乗る矮人」。git とこのアプリが何の上に立っているかの銘 -->
            <button class="motto" lang="la" title="出典を見る" onclick={() => (mottoOpen = true)}>
              nani gigantum humeris insidentes
            </button>
            <button onclick={() => void app.openRepository()}>リポジトリを開く</button>
          </div>
        </div>
      {:else if logMode}
        <!--
          コミットログモード（決定 27）。
          左のブランチペインは差分モードと共通（同じ幅・同じ折り畳み状態）で、
          右が上＝グラフ付きコミットリスト／下＝選択コミットの詳細の上下 2 分割になる。
        -->
        <main class="panes" style:grid-template-columns={logColumns}>
          {#if !leftCollapsed}
            <BranchPane />
            <PaneSplitter
              value={leftWidth}
              min={120}
              max={1200}
              onchange={(w) => (liveLeftWidth = w)}
              oncommit={commitLeftWidth}
            />
          {/if}
          <!-- 下の分割線は「下端パネルの上端」にあるので、上へ引くと大きくなる（invert）。 -->
          <div class="log-split" style:grid-template-rows={logRows}>
            <CommitLogPane />
            <PaneSplitter
              axis="y"
              invert
              value={detailHeight}
              min={120}
              max={2000}
              onchange={(h) => (liveDetailHeight = h)}
              oncommit={commitDetailHeight}
            />
            <CommitDetailPane />
          </div>
        </main>
      {:else}
        <main class="panes" style:grid-template-columns={gridColumns} bind:clientWidth={panesWidth}>
          {#if !leftCollapsed}
            <BranchPane />
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
  </div>
</div>

<!--
  オーバーレイ（position: fixed のもの）は必ずここ、shell の外に置く。
  ペインの内側に置くと、DOM 上で後ろに来るペインが上に描画され、
  背後のペインがクリックやマウスオーバーを拾ってしまう。
  前後関係は tokens.css の --app-layer-* だけで決まる（この並び順には依存しない）。
-->
<ConfirmDialog />
<CreateBranchDialog />
<PushDialog />
<OptionsDialog open={optionsOpen} onclose={() => (optionsOpen = false)} />
<MottoDialog open={mottoOpen} onclose={() => (mottoOpen = false)} />
<FocusRefreshDialog />

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .app-header {
    flex: 0 0 auto;
  }

  /*
   * タブ段。決定 24 でここが旧 OS ウィンドウ枠の位置になった。
   *
   * 右端は OS が ─ □ × を描く領域なので、その幅だけ空けておく。
   * env(titlebar-area-width) はウィンドウ幅から OS のボタン分を引いた値で、
   * 最大化・復元・DPI 変更のたびに OS 側が入れ直してくれる。
   * env() が無い環境ではトークンの見込み幅に落とす。
   */
  .tabbar {
    display: flex;
    align-items: flex-end;
    height: var(--app-metric-tabbar-height);
    padding-right: calc(
      100vw - env(titlebar-area-width, calc(100vw - var(--app-metric-caption-reserve)))
    );
    background: var(--app-bg-raised);
    -webkit-app-region: drag;
  }

  .drag-spacer {
    flex: 1 1 auto;
    align-self: stretch;
    min-width: 0;
  }

  .tabs {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    overflow-x: auto;
    /* 縦スクロールバーが出ると行が潰れる。横だけ許す。 */
    overflow-y: hidden;
    min-width: 0;
    height: 100%;
    -webkit-app-region: no-drag;
  }

  /* タブ列の横スクロールバーはタブ段の高さを食うので出さない（ホイールで送る）。 */
  .tabs::-webkit-scrollbar {
    height: 0;
  }

  /*
   * アクティブタブだけ下のツールバー段と同じ面にして、地続きに見せる。
   * 下辺の角は丸めない（丸めるとツールバー段との間に切れ目が見える）。
   */
  .tab {
    display: flex;
    align-items: center;
    height: calc(var(--app-metric-tabbar-height) - 4px);
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: var(--app-metric-radius) var(--app-metric-radius) 0 0;
    -webkit-app-region: no-drag;
  }

  .tab:hover:not(.active) {
    background: var(--app-bg-hover);
  }

  .tab.active {
    height: var(--app-metric-tabbar-height);
    background: var(--app-bg-surface);
    border-color: var(--app-border-subtle);
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
    -webkit-app-region: no-drag;
  }

  /*
   * タブのラベル（決定 24）。「リポジトリ名 + ブランチ名の丸 + HEAD の件名」。
   * 幅の上限は設けない（タブ段が横スクロールする）。長い名前はツールチップではなく
   * スラッシュの最終セグメントだけを出すことで抑える。
   */
  .tab-label {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: grab;
  }

  .tab-repo {
    flex: 0 0 auto;
  }

  /*
   * ブランチ名の丸。コミットログペインの名札（CommitRow.svelte の .ref）と同じ見え方にする。
   * 共通コンポーネントにしていないのは、あちらが 3 種類（ローカル / リモート / HEAD）の
   * 出し分けと行の高さに合わせた寸法を持っており、こちらは 1 種類・タブ段の高さ
   * （34px）に収まる寸法しか要らないため。どちらかの見た目を変えるときは両方直す。
   */
  .tab-branch {
    flex: 0 0 auto;
    padding: 0 6px;
    background: var(--app-accent);
    border-radius: var(--app-metric-radius-pill);
    color: var(--app-bg-surface);
    font-size: var(--app-font-size-mono);
    font-weight: 700;
    line-height: 15px;
  }

  /* 件名は本文より引いた色にする。タブの主役はリポジトリ名とブランチ名。 */
  .tab-subject {
    flex: 0 0 auto;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .tab-close {
    padding: 3px 6px;
    color: var(--app-text-muted);
  }

  .tab-add {
    flex: 0 0 auto;
    align-self: center;
  }

  /* ツールバー段。左＝リポジトリに効くもの、右＝アプリ全体に効くもの。 */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-metric-gap);
    padding: 4px 8px;
    background: var(--app-bg-surface);
    border-bottom: 1px solid var(--app-border-subtle);
  }

  .toolbar-group {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .body {
    flex: 1 1 auto;
    display: flex;
    min-height: 0;
  }

  .body-main {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    /* グリッド/フレックスの子は既定で min-content 未満に縮まない。
       これが無いと中身の広いペインがウィンドウ幅を押し広げる。 */
    min-width: 0;
    min-height: 0;
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

  /*
   * コミットログモードの右側。ブランチペインの隣に座るグリッドアイテムで、
   * 中を上下に割る（決定 27）。min-* を 0 にしないと中身がトラックを押し広げる。
   */
  .log-split {
    display: grid;
    min-width: 0;
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

  /*
   * ラテン語の銘。操作の説明ではないので、本文より一段引いた見た目にする。
   * 押せる（出典が出る）のでボタンにしてあるが、base.css のボタン装飾は全部外して
   * ただの文にする。押せることはホバーでだけ伝える。
   */
  .notice .motto {
    display: block;
    margin: 6px auto;
    padding: 2px 4px;
    background: none;
    border: none;
    border-radius: 0;
    color: var(--app-text-muted);
    font-style: italic;
    letter-spacing: 0.02em;
  }

  .notice .motto:hover {
    color: var(--app-text-secondary);
    background: none;
  }

  .notice .motto:focus-visible {
    outline: 1px solid var(--app-accent);
    outline-offset: 0;
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
