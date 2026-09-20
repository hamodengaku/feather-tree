<script lang="ts">
  import type { BranchDto } from '@feathertree/ipc';
  import { app } from '../lib/appState.svelte.js';
  import PaneSplitter from '../components/PaneSplitter.svelte';
  import FileContextMenu from '../components/FileContextMenu.svelte';
  import VirtualBranchList from '../components/VirtualBranchList.svelte';
  import {
    buildBranchTree,
    isRepeatClick,
    planCurrentBranchSeed,
    toExpandedSet,
    withCollapsed,
    withExpanded,
  } from '../lib/branchTree.js';
  import type { BranchFolderRow, BranchScope, BranchTreeRow } from '../lib/branchTree.js';

  let liveLocalHeight = $state<number | null>(null);
  const storedLocalHeight = $derived(liveLocalHeight ?? app.settings?.branchLocalHeight ?? 180);

  function commitLocalHeight(next: number): void {
    liveLocalHeight = null;
    void app.setBranchLocalHeight(next);
  }

  /** ドラッグの上限。リモート側に最低 40px は残す。 */
  let listsHeight = $state(0);
  const maxLocalHeight = $derived(Math.max(80, listsHeight - 40));

  /**
   * 実際に grid-template-rows に入れる高さ。
   * 保存値は 80..4000 でしか丸めていないので、ウィンドウが低い状態で起動すると
   * リモート側の行が 0 まで潰れてしまう。高さを測れているときだけ上限で抑える
   * （測る前の 1 フレーム目に 80px へ潰れないよう、0 のときは保存値をそのまま使う）。
   */
  const localHeight = $derived(
    listsHeight === 0 ? storedLocalHeight : Math.min(storedLocalHeight, maxLocalHeight),
  );

  // ブランチ一覧は status とは別に保持する（更新ボタンとタブの切り替わりで取り直す）。
  // 削除・名前変更は Phase 6 の残り。
  const locals = $derived(app.branches.filter((b) => !b.isRemote));
  const remotes = $derived(app.branches.filter((b) => b.isRemote));

  /** 展開中のフォルダ（リポジトリごとに保存されている。既定は全折りたたみ）。 */
  const expanded = $derived(toExpandedSet(app.branchExpanded));
  const localRows = $derived(buildBranchTree(locals, expanded, 'local'));
  const remoteRows = $derived(buildBranchTree(remotes, expanded, 'remote'));

  /**
   * 現在のブランチへの経路だけは自動で開く。判断そのものは純関数
   * （lib/branchTree.ts の planCurrentBranchSeed）に置いてあり、ここはその適用だけ。
   *
   * 「リポジトリ × ブランチ」の組ごとに一度きりなので、ユーザーが畳み直したものを
   * 開き直すことはない（次にそのブランチへ切り替えるまで畳んだまま）。
   *
   * **この記録はコンポーネントの生存期間に結びついている。** 作り直されれば空に戻り、
   * 畳んだフォルダが開き直される。App.svelte が `<BranchPane />` を表示モードの分岐の
   * 外に置いているのはそのため（両枝に書くとモード切替のたびに作り直される）。
   */
  const seeded: string[] = [];
  $effect(() => {
    const decision = planCurrentBranchSeed({
      sessionId: app.activeId,
      branch: app.currentBranch,
      settingsReady: app.settings !== null,
      expanded: app.branchExpanded,
      seeded,
    });
    if (decision.mark === null) return;
    seeded.push(decision.mark);
    if (decision.expanded !== null) saveExpanded(decision.expanded);
  });

  /**
   * 展開状態の保存。**reject は必ず受ける。**
   * `void` で捨てると unhandled rejection になり、失敗が誰にも見えないまま消える
   * （保存に失敗しても表示は続けられるので、ここでは握って次の更新に任せる。
   *   利用者向けの通知は appState 側が出す）。
   */
  function saveExpanded(paths: readonly string[]): void {
    app.setBranchExpanded(paths).catch(() => undefined);
  }

  /** 開くときは通過するすべての前置きを、畳むときは子孫までまとめて扱う。 */
  function toggleFolder(scope: BranchScope, row: BranchFolderRow): void {
    const current = app.branchExpanded;
    saveExpanded(
      row.expanded
        ? withCollapsed(current, scope, row.path)
        : withExpanded(current, scope, row.path),
    );
  }

  /** 階層の深さ 1 段につき 12px 下げる。8px は行の左パディング分。 */
  function indent(depth: number): string {
    return 8 + depth * 12 + 'px';
  }

  /** 3 桁以上は行が伸びすぎるので丸める。正確な数はツールチップで足りる。 */
  function badge(count: number): string {
    return count > 99 ? '99+' : String(count);
  }

  /** 行のラベルは最終セグメントだけなので、完全な名前はツールチップで補う。 */
  function nameTitle(branch: BranchDto): string {
    return branch.subject.length > 0 ? branch.shortName + '\n' + branch.subject : branch.shortName;
  }

  /**
   * 現在のブランチの印は、一覧の isHead ではなく status 由来の HEAD で判定する。
   * 切替・作成の直後は一覧を取り直さない（status のみ再取得）ので、
   * 一覧側の isHead は古いままになるため。
   */
  function isCurrent(branch: BranchDto): boolean {
    return !branch.isRemote && branch.shortName === app.currentBranch;
  }

  /**
   * ダブルクリックでのブランチ切替（対応表 #12 / #47）。無確認で即実行する。
   *
   * 送るのは**一覧に出ている名前そのまま**（リモートなら `origin/feature/x`）。
   * ローカルへ取り出すのか既存のローカル枝へ移るだけなのかは、一覧を持っている
   * main が決める（renderer で名前を削ると、同名のブランチを持つリモートが 2 つある
   * ときに行き先が曖昧になる）。
   */
  async function handleSwitch(branch: BranchDto): Promise<void> {
    if (app.busy || localNameOf(branch) === app.currentBranch) return;
    await app.switchBranch(branch.shortName);
  }

  /**
   * その行に移ったときに居ることになるローカルブランチ名。
   * リモート行は git が `--track` で付ける名前と同じ決め方（リモート名を 1 段落とす）。
   * 既にそこに居るならダブルクリックを捨てる（git を無駄に動かさない）ために使う。
   */
  function localNameOf(branch: BranchDto): string {
    if (!branch.isRemote) return branch.shortName;
    const slash = branch.shortName.indexOf('/');
    return slash === -1 ? branch.shortName : branch.shortName.slice(slash + 1);
  }

  /**
   * ローカルブランチの右クリックメニュー（マージ）。
   * リモートは fetch/pull が未実装のため対象にしない。
   */
  let contextMenu = $state<{ x: number; y: number; branch: BranchDto } | null>(null);

  function handleContextMenu(branch: BranchDto, event: MouseEvent): void {
    event.preventDefault();
    // 現在のブランチ自身は取り込めないのでメニューを出さない
    if (isCurrent(branch)) return;
    contextMenu = { x: event.clientX, y: event.clientY, branch };
  }

  /** 作成の起点が定まらない状態（detached HEAD など）では「＋」を押させない。 */
  const canCreateBranch = $derived(app.currentBranch !== null);
</script>

{#snippet tracking(branch: BranchDto)}
  {#if branch.ahead > 0}
    <span class="track ahead" title="上流より {branch.ahead} コミット進んでいる">↑{badge(branch.ahead)}</span>
  {/if}
  {#if branch.behind > 0}
    <span class="track behind" title="上流より {branch.behind} コミット遅れている">↓{badge(branch.behind)}</span>
  {/if}
  {#if branch.gone}<span class="gone">gone</span>{/if}
{/snippet}

{#snippet branchRow(row: BranchTreeRow, scope: BranchScope)}
  {#if row.kind === 'folder'}
    <li class="folder">
      <button
        class="folder-btn"
        aria-expanded={row.expanded}
        title={row.path}
        style:padding-left={indent(row.depth)}
        onclick={(event) => {
          // ダブルクリックの 2 打目で開いた直後に閉じてしまうのを防ぐ
          if (isRepeatClick(event.detail)) return;
          toggleFolder(scope, row);
        }}
      >
        <span class="twisty">{row.expanded ? '▼' : '▶'}</span>
        <span class="name">{row.label}</span>
        {#if row.branch !== null}{@render tracking(row.branch)}{/if}
      </button>
    </li>
  {:else if scope === 'local'}
    <li
      class:current={isCurrent(row.branch)}
      title="ダブルクリックでこのブランチに切り替え／右クリックでマージ"
      style:padding-left={indent(row.depth)}
      ondblclick={() => void handleSwitch(row.branch)}
      oncontextmenu={(event) => handleContextMenu(row.branch, event)}
    >
      <span class="dot">{isCurrent(row.branch) ? '●' : ''}</span>
      <span class="name" title={nameTitle(row.branch)}>{row.label}</span>
      {@render tracking(row.branch)}
    </li>
  {:else}
    <li
      title="ダブルクリックでローカルに取り出して切り替え"
      style:padding-left={indent(row.depth)}
      ondblclick={() => void handleSwitch(row.branch)}
    >
      <span class="dot"></span>
      <span class="name" title={nameTitle(row.branch)}>{row.label}</span>
    </li>
  {/if}
{/snippet}

{#snippet remoteRow(row: BranchTreeRow)}{@render branchRow(row, 'remote')}{/snippet}
{#snippet localRow(row: BranchTreeRow)}{@render branchRow(row, 'local')}{/snippet}

<!--
  リモートとローカルの 2 セクションだけ。
  今どのブランチに居るかは一覧の中で印と太字で示す（isCurrent）ので、
  同じ情報を固定ヘッダで二重に持たない。
-->
<div class="pane">
  <div class="lists" style:grid-template-rows="1fr 6px {localHeight}px" bind:clientHeight={listsHeight}>
    <section class="list">
      <div class="list-header">
        <h2>リモート <span class="count">{remotes.length}</span></h2>
      </div>
      <VirtualBranchList rows={remoteRows} row={remoteRow} />
    </section>

    <PaneSplitter
      axis="y"
      value={localHeight}
      min={80}
      max={maxLocalHeight}
      invert
      onchange={(h) => (liveLocalHeight = h)}
      oncommit={commitLocalHeight}
    />

    <section class="list">
      <div class="list-header">
        <h2>ローカル <span class="count">{locals.length}</span></h2>
        <button
          class="new-branch-btn"
          title="新しいブランチを作成"
          disabled={!canCreateBranch}
          onclick={() => app.openCreateBranch()}
        >
          ＋
        </button>
      </div>
      <VirtualBranchList rows={localRows} row={localRow} />
    </section>
  </div>
</div>

{#if contextMenu !== null}
  {@const menu = contextMenu}
  <FileContextMenu
    x={menu.x}
    y={menu.y}
    onclose={() => (contextMenu = null)}
    actions={[
      {
        label: menu.branch.shortName + " をマージ",
        onclick: () => void app.mergeBranch(menu.branch.shortName),
      },
    ]}
  />
{/if}

<style>
  .pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    /* main.panes のグリッドアイテムそのもの。min-width の既定（auto = min-content 幅）だと
       ペインを狭めたときに中身が隣のペインへはみ出す。 */
    min-width: 0;
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

  /*
   * flex-basis は 0。auto にすると基準サイズがブランチ件数 × 行高になり、
   * ペインに収まらない負の余剰が兄弟セクションを潰しにかかる。
   */
  .lists {
    display: grid;
    flex: 1 1 0;
    min-height: 0;
  }

  section.list {
    min-height: 0;
    min-width: 0;
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

  .list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: 0 0 auto;
    background: var(--app-bg-surface);
    border-bottom: 1px solid var(--app-border-subtle);
  }

  .list-header h2 {
    padding: 6px 0 6px 8px;
    background: none;
    border-bottom: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .new-branch-btn {
    flex: 0 0 auto;
    background: none;
    border: none;
    color: var(--app-text-secondary);
    cursor: pointer;
    font-size: var(--app-font-size-ui);
    line-height: 1;
    padding: 4px 8px;
    margin-right: 4px;
  }

  .new-branch-btn:hover:not(:disabled) {
    color: var(--app-text-primary);
    background: var(--app-bg-hover);
  }

  .new-branch-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .count {
    color: var(--app-text-muted);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  li {
    display: flex;
    align-items: center;
    gap: 5px;
    height: var(--app-metric-row-height);
    /* 左は階層の深さに応じてインラインで指定する。 */
    padding: 0 8px 0 0;
    cursor: pointer;
    white-space: nowrap;
    /* 横スクロールしても背景が途切れないよう、内容幅とペイン幅の広い方に合わせる。 */
    width: max-content;
    min-width: 100%;
  }

  li:hover {
    background: var(--app-bg-hover);
  }

  li.current {
    font-weight: 600;
  }

  /*
   * フォルダ行の実体は中のボタン。<li role="button"> にすると
   * 非対話要素に対話ロールを載せることになる（a11y_no_noninteractive_element_to_interactive_role）。
   */
  li.folder {
    display: block;
    height: auto;
    padding: 0;
  }

  .folder-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    height: var(--app-metric-row-height);
    /* 左は階層の深さに応じてインラインで指定する。 */
    padding: 0 8px 0 0;
    background: none;
    border: none;
    border-radius: 0;
    color: var(--app-text-secondary);
    cursor: pointer;
    white-space: nowrap;
    text-align: left;
  }

  .folder-btn:focus-visible {
    outline: 1px solid var(--app-accent);
    outline-offset: -1px;
  }

  /* U+25B6 / U+25BC は字面いっぱいの三角なので、行高 22px なら 9px で十分に見える。 */
  .twisty {
    flex: 0 0 auto;
    width: 12px;
    color: var(--app-text-muted);
    font-size: 9px;
    line-height: 1;
  }

  .dot {
    flex: 0 0 auto;
    width: 10px;
    color: var(--app-accent);
    font-size: 9px;
  }

  .name {
    flex: 0 0 auto;
  }

  /* ahead / behind は丸枠で括って、行の中で埋もれないようにする。 */
  .track {
    flex: 0 0 auto;
    padding: 0 5px;
    border: 1px solid currentColor;
    border-radius: var(--app-metric-radius-pill);
    background: var(--app-bg-raised);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    line-height: 1.4;
  }

  .track.ahead {
    color: var(--app-text-added);
  }

  .track.behind {
    color: var(--app-text-modified);
  }

  .gone {
    flex: 0 0 auto;
    color: var(--app-text-danger);
    font-size: var(--app-font-size-mono);
  }

</style>
