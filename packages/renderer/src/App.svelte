<script lang="ts">
  import { app } from './lib/appState.svelte.js';
  import { branchLeaf, truncateSubject } from './lib/tabLabel.js';
  import BranchPane from './panes/BranchPane.svelte';
  import WorkingTreePane from './panes/WorkingTreePane.svelte';
  import DiffPane from './panes/DiffPane.svelte';
  import UnityPane from './panes/UnityPane.svelte';
  import CommitLogPane from './panes/CommitLogPane.svelte';
  import CommitDetailPane from './panes/CommitDetailPane.svelte';
  import StashListPane from './panes/StashListPane.svelte';
  import StashDetailPane from './panes/StashDetailPane.svelte';
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
  import OpenRepositoryMenu from './components/OpenRepositoryMenu.svelte';
  import CloneDialog from './components/CloneDialog.svelte';
  import CloneConfirmDialog from './components/CloneConfirmDialog.svelte';
  import { fade } from 'svelte/transition';

  /** 読み込み帯の出入りの所要時間。Svelte の transition は CSS 変数を取れないのでここに置く。 */
  const BAND_FADE_MS = 160;

  void app.initialize();

  const gitMissing = $derived(app.environment !== null && app.environment.gitPath === null);

  /**
   * ペイン領域のモード（決定 27 / 31）。
   *
   * **ブランチペインは 5 つのモードで共通**で、左に居続ける（幅も折り畳み状態も同じ設定）。
   * モードが替えるのはその右側だけ:
   *   差分 / Stash 保存 / Unity … 左右 2 分割。**作業ツリーペインは同じ実体を使う**
   *   コミットログ       … 上下 2 分割（コミットリスト / コミット詳細）
   *   Stash 解放         … 上下 2 分割（stash 一覧 / stash 詳細）
   *
   * 列の定義（gridColumns）より前に置いてあるのは、そちらが参照するため。
   */
  const logMode = $derived(app.viewMode === 'log');
  const stashListMode = $derived(app.viewMode === 'stash-list');
  /**
   * Unity Prefab 差分モード（決定 32）。
   *
   * 列の作りは差分モードと同じ 3 トラックなので splitMode には入れない。
   * 替わるのは第 3 トラック（差分ペイン ↔ Unity ペイン）だけ。
   */
  const unityMode = $derived(app.viewMode === 'unity');
  /**
   * 右側が上下 2 分割になるモード（コミットログ / Stash 解放）。
   * 列の作りは同じなので、gridColumns はこれ 1 つで足りる。
   */
  const splitMode = $derived(logMode || stashListMode);

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
   * ペイン領域の列。**全モードで 1 つの grid**（＝ブランチペインは 1 インスタンス）。
   *
   * 左側（ブランチペイン + 分割線）の扱いはモードに依らず同じで、右側だけが替わる。
   * 上下に割るモード（コミットログ / Stash 解放）の右側は 1 トラック
   * （中を上下に割るのは .log-split / .stash-split の仕事）。
   *
   * 差分モードの右側は、通常時は fr 単位で比率だけを指定し、ウィンドウ伸縮に応じた
   * ブラウザ側の再配分に任せる（center/diff がブランチペイン幅を保ったまま連動して伸縮し、
   * diff は minmax で消えない）。ドラッグ中だけ px 値に切り替え、
   * PaneSplitter の col-resize の感触を保つ。
   */
  const gridColumns = $derived.by(() => {
    const right = splitMode
      ? 'minmax(0, 1fr)'
      : liveCenterWidth !== null
        ? `${liveCenterWidth}px 6px minmax(200px, 1fr)`
        : `minmax(160px, ${ratio}fr) 6px minmax(200px, ${1 - ratio}fr)`;
    return leftCollapsed ? right : `${leftWidth}px 6px ${right}`;
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

  let liveDetailHeight = $state<number | null>(null);
  const detailHeight = $derived(liveDetailHeight ?? app.settings?.logDetailHeight ?? 260);
  const logRows = $derived(`minmax(80px, 1fr) 6px ${String(detailHeight)}px`);

  function commitDetailHeight(nextPx: number): void {
    liveDetailHeight = null;
    void app.setLogDetailHeight(nextPx);
  }

  // ---------------------------------------------------------------- Stash 解放モードの上下分割

  /**
   * コミットログモードと同じ形だが、**高さは別に持つ**（決定 31）。
   * 読むものの量が違うので、片方で決めた高さがもう片方へ伝染すると
   * モードを行き来するたびに直すことになる。
   */
  let liveStashDetailHeight = $state<number | null>(null);
  const stashDetailHeight = $derived(liveStashDetailHeight ?? app.settings?.stashDetailHeight ?? 260);
  const stashRows = $derived(`minmax(80px, 1fr) 6px ${String(stashDetailHeight)}px`);

  function commitStashDetailHeight(nextPx: number): void {
    liveStashDetailHeight = null;
    void app.setStashDetailHeight(nextPx);
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

  /**
   * 「リポジトリを開く」のポップアップ（ローカル／クローン）をボタンの真下に出す。
   * 初期画面のボタンとタブ段の「＋」が共用する。メニュー本体は下の OpenRepositoryMenu。
   */
  function showOpenMenu(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    app.showOpenRepositoryMenu(Math.round(rect.left), Math.round(rect.bottom + 2));
  }

  // ---------------------------------------------------------------- 失敗の導線（決定 26 の改定）

  /**
   * 失敗の件数。ログボタンの丸に出すだけで、画面は塞がない。
   * 実体は「実行ログ」パネルの「エラー」タブ（CommandLogPanel）にある。
   *
   * **パネルで実際に見える件数**（表示範囲で絞った後）を数える。2026-09-23 改定。
   * 以前はここだけ全件を数えていたため、「ログ ③」と出ているのに開くとエラータブが空、
   * ということが普通に起きていた。丸の数字とパネルの中身は必ず一致させる。
   */
  const errorCount = $derived(app.visibleErrorLog.length);
  /** 3 桁以上は丸める（ボタンの幅が動くと押し間違いを招く）。 */
  const errorBadge = $derived(errorCount > 99 ? '99+' : String(errorCount));
  /** 表示範囲の外にある分。丸には出さない（一致させるため）ので、ツールチップで補う。 */
  const hiddenErrorCount = $derived(app.errorLog.length - errorCount);

  const logButtonTitle = $derived.by((): string => {
    const lines: string[] = [];
    if (errorCount > 0) lines.push(`失敗が ${String(errorCount)} 件あります`);
    if (hiddenErrorCount > 0) {
      lines.push(`表示範囲の外にさらに ${String(hiddenErrorCount)} 件（「開いているすべてのリポジトリ」で出ます）`);
    }
    return lines.length === 0 ? '実行ログを開く' : lines.join('\n');
  });

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
            <!--
              読み込み帯（決定 26。発動条件は lib/tabActivity.ts）。
              背景に敷くのでタブの幅を変えない。出ていない間は要素ごと無い（待機時に動くものを残さない）。
            -->
            {#if app.isUpdating(session.id)}
              <span class="tab-band" aria-hidden="true" transition:fade={{ duration: BAND_FADE_MS }}></span>
            {/if}
            <button
              class="tab-label"
              role="tab"
              aria-selected={session.id === app.activeId}
              aria-busy={app.isUpdating(session.id)}
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
        <button class="tab-add" title="リポジトリを開く" aria-haspopup="menu" onclick={showOpenMenu}>＋</button>
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
        <!--
          失敗はパネルの中にしまったので、**気づく導線をここに 1 つだけ残す**（決定 26 の改定）。
          モーダルにはしない（操作を止めない）。件数の丸を出すだけで、開くかは利用者が決める。
        -->
        <button
          class:has-errors={errorCount > 0}
          title={logButtonTitle}
          onclick={() => void app.toggleCommandLog()}
        >
          ログ
          {#if errorCount > 0}
            <span class="log-badge">{errorBadge}</span>
          {/if}
        </button>
      </div>
    </div>
  </header>

  <!--
    アプリヘッダより下は、左に縦帯（常設）、右に本体。
    警告帯・実行ログパネルも本体側に入れる（縦帯はそれらより下まで通す）。
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
            <button aria-haspopup="menu" onclick={showOpenMenu}>リポジトリを開く</button>
          </div>
        </div>
      {:else}
        <!--
ペイン領域（決定 27 / 31）。**4 つのモードで 1 つの grid**。

          ブランチペインをモード分岐の外に出してあるのは、**同じインスタンスを生かし続ける**ため。
          両枝に書くとモードを切り替えるたびに破棄・再生成され、BranchPane が持つ
          「現在ブランチへの経路をシード済みか」の記録が初期化されて、
          利用者が意図的に畳んだフォルダが開き直される（lib/branchTree.ts の
          planCurrentBranchSeed の注記）。モードが替えるのは右側だけ。
        -->
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

          {#if logMode}
            <!--
              右は上＝グラフ付きコミットリスト／下＝選択コミットの詳細の上下 2 分割。
              下の分割線は「下端パネルの上端」にあるので、上へ引くと大きくなる（invert）。
            -->
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
          {:else if stashListMode}
            <!-- Stash 解放モード（決定 31）。上＝ stash 一覧／下＝選んだ stash の中身。 -->
            <div class="stash-split" style:grid-template-rows={stashRows}>
              <StashListPane />
              <PaneSplitter
                axis="y"
                invert
                value={stashDetailHeight}
                min={120}
                max={2000}
                onchange={(h) => (liveStashDetailHeight = h)}
                oncommit={commitStashDetailHeight}
              />
              <StashDetailPane />
            </div>
          {:else}
            <!--
              差分モード・Stash 保存モード・Unity モードは**同じ土台**（決定 31 / 32）。
              ここで作業ツリーペインを分岐させないのが要で、
              替わるのは「下端の箱」（Stash）と「第 3 トラック」（Unity）だけ。
              両枝に書くと切り替えのたびに破棄・再生成され、選択もスクロールも飛ぶ。
            -->
            <WorkingTreePane />
            <PaneSplitter
              value={centerWidthPx}
              min={160}
              max={Math.max(160, availableCD - 200)}
              onchange={(w) => (liveCenterWidth = w)}
              oncommit={commitCenterWidth}
            />
            {#if unityMode}
              <UnityPane />
            {:else}
              <DiffPane />
            {/if}
          {/if}
        </main>
      {/if}

      <!--
        失敗の表示先は「実行ログ」パネルの「エラー」タブ（決定 26 の 2026-09-19 改定）。
        画面下端のエラー帯はここにあったが廃止した——1 件しか持てず、
        手で閉じるまで消えないので、原因が解消した後も「今も壊れている」ように見えていた。
      -->
      {#if app.showCommandLog}
        <CommandLogPanel />
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
<CloneDialog />
<CloneConfirmDialog />
<OpenRepositoryMenu />
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
    /* 読み込み帯（.tab-band）の絶対配置の基準 */
    position: relative;
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
   * 読み込み帯（決定 26）。「このタブに出ている内容は古く、まもなく変わる」の印。
   *
   * 背景に敷くのでタブの幅を変えない（印を差し込むと右側のタブが全部ずれ、× の押し間違いを招く）。
   * 進捗率は分からないので全幅の不定形にする。一部だけ塗ると「そこで止まっている」と読まれる。
   *
   * 地の薄い色（::before）と流れる明るい帯（::after）を分けてあるのは、
   * 動きを抑える設定で帯だけを止め、地を明滅させるため。
   * 要素そのものには opacity を書かない（Svelte の fade が同じ opacity を直接書き換える）。
   *
   * 動かすのは transform と opacity だけ。background-position のアニメーションは
   * 毎フレームの再ペイントになるので使わないこと。
   */
  .tab-band {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    overflow: hidden;
    pointer-events: none;
  }

  .tab-band::before {
    content: '';
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--app-accent) 11%, transparent);
  }

  .tab-band::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 45%;
    background: linear-gradient(
      90deg,
      transparent,
      color-mix(in srgb, var(--app-accent) 30%, transparent),
      transparent
    );
    transform: translateX(-100%);
    animation: tab-band-sweep 1.8s ease-in-out infinite;
  }

  @keyframes tab-band-sweep {
    to {
      transform: translateX(230%);
    }
  }

  /* 動きを抑える設定では流さない。止まっていないことは地の明滅で示す。 */
  @media (prefers-reduced-motion: reduce) {
    .tab-band::after {
      animation: none;
      opacity: 0;
    }

    .tab-band::before {
      animation: tab-band-pulse 1.6s ease-in-out infinite;
    }
  }

  @keyframes tab-band-pulse {
    50% {
      opacity: 0.35;
    }
  }

  /* 帯（絶対配置）より手前に描く。位置指定の無い要素は、絶対配置の兄弟より奥に描かれるため。 */
  .tab-label,
  .tab-close {
    position: relative;
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
   * 上下に割るモードの右側（コミットログ / Stash 解放）。ブランチペインの隣に座る
   * グリッドアイテムで、中を上下に割る（決定 27 / 31）。
   * min-* を 0 にしないと中身がトラックを押し広げる。
   *
   * 2 つを 1 つのセレクタにまとめず並べてあるのは、**高さの設定が別**だから
   * （見た目の規則が同じことと、状態を共有することは別）。
   */
  .log-split,
  .stash-split {
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

  /*
   * ログボタンの失敗バッジ（決定 26 の改定）。廃止したエラー帯の代わりの、唯一の導線。
   * 見え方はタブのブランチ名の丸・ブランチペインの ahead/behind と同じ作法
   * （角丸ピル・等幅・1 行）。色も寸法もトークンだけで決める。
   */
  .log-badge {
    display: inline-block;
    margin-left: 5px;
    padding: 0 5px;
    background: var(--app-text-danger);
    border-radius: var(--app-metric-radius-pill);
    color: var(--app-bg-surface);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    font-weight: 700;
    line-height: 1.4;
  }

  .has-errors {
    border-color: var(--app-text-danger);
  }
</style>
