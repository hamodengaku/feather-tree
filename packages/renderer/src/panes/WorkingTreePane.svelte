<script lang="ts">
  import type { FileEntryDto } from '@feathertree/ipc';
  import { app } from '../lib/appState.svelte.js';
  import VirtualFileList from '../components/VirtualFileList.svelte';
  import FileContextMenu from '../components/FileContextMenu.svelte';
  import PaneSplitter from '../components/PaneSplitter.svelte';
  import StashSaveBox from '../components/StashSaveBox.svelte';
  import { EMPTY_SELECTION, nextSelection, type SelectionState } from '../lib/selection.js';

  /**
   * このペインは**差分モードと Stash 保存モードで共用**する（決定 31）。
   * 替わるのは下端の箱だけで、ファイル一覧もステージ操作も同じものを使う
   * （モードで分岐して別のペインを描くと、切り替えるたびに選択とスクロールが飛ぶ）。
   */
  const stashMode = $derived(app.viewMode === 'stash');

  const stagedCount = $derived(app.summary?.counts.staged ?? 0);
  const changesTotal = $derived(app.changes.total);

  let liveStagedHeight = $state<number | null>(null);
  const stagedHeight = $derived(liveStagedHeight ?? app.settings?.stagedHeight ?? 180);

  function commitStagedHeight(next: number): void {
    liveStagedHeight = null;
    void app.setStagedHeight(next);
  }

  /** ドラッグの上限。変更側に最低 40px は残す。 */
  let groupsHeight = $state(0);
  const maxStagedHeight = $derived(Math.max(80, groupsHeight - 40));

  let stagedSelection = $state<SelectionState>(EMPTY_SELECTION);
  let changesSelection = $state<SelectionState>(EMPTY_SELECTION);
  let contextMenu = $state<{ x: number; y: number; staged: boolean; entry: FileEntryDto } | null>(null);

  // 一覧の内容が変わったら、消えたパスを指している複数選択を残さないようにリセットする。
  $effect(() => {
    void app.staged.total;
    stagedSelection = EMPTY_SELECTION;
  });
  $effect(() => {
    void app.changes.total;
    changesSelection = EMPTY_SELECTION;
  });

  function handleSelect(entry: FileEntryDto, event: MouseEvent | KeyboardEvent, index: number, staged: boolean): void {
    const click = {
      index,
      path: entry.path,
      ctrlKey: event.ctrlKey || event.metaKey,
      shiftKey: event.shiftKey,
    };
    const entries = staged ? app.staged.entries : app.changes.entries;
    const next = nextSelection(staged ? stagedSelection : changesSelection, click, entries);
    if (staged) stagedSelection = next;
    else changesSelection = next;
    if (!click.ctrlKey && !click.shiftKey) void app.select({ path: entry.path, staged });
  }

  /**
   * ディスクにファイルの実体があるか。削除済みでは「ファイルを開く」を押させない。
   * 削除は staged 側なら 'D.'、未ステージなら '.D' として出る。
   */
  function existsOnDisk(entry: FileEntryDto): boolean {
    return entry.worktree !== 'D' && entry.staged !== 'D';
  }

  function handleContextMenu(entry: FileEntryDto, event: MouseEvent, index: number, staged: boolean): void {
    const current = staged ? stagedSelection : changesSelection;
    if (!current.selected.has(entry.path)) {
      const replaced: SelectionState = { selected: new Set([entry.path]), anchorIndex: index };
      if (staged) stagedSelection = replaced;
      else changesSelection = replaced;
    }
    contextMenu = { x: event.clientX, y: event.clientY, staged, entry };
  }
</script>

<div class="pane">
  <div class="groups" style:grid-template-rows="{stagedHeight}px 6px 1fr" bind:clientHeight={groupsHeight}>
    <section class="group">
      <header>
        <!--
          セーブモードでは見出しを変えて色を替える（決定 31）。
          同じ一覧が「コミットの材料」ではなく「退避の材料」であることを、
          下端の箱まで視線を落とさなくても分かるようにするため。
        -->
        <h2 class:stash={stashMode}>
          {stashMode ? 'Stash ステージ済み' : 'ステージ済み'}
          <span class="count">{stagedCount}</span>
        </h2>
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
        multiSelectedPaths={stagedSelection.selected}
        onselect={(entry, event, index) => handleSelect(entry, event, index, true)}
        ondblclick={(entry) => void app.toggleStage({ path: entry.path, staged: true })}
        oncontextmenu={(entry, event, index) => handleContextMenu(entry, event, index, true)}
        onneedpage={(offset) => void app.loadMore('staged', offset)}
      />
    </section>

    <PaneSplitter
      axis="y"
      value={stagedHeight}
      min={80}
      max={maxStagedHeight}
      onchange={(h) => (liveStagedHeight = h)}
      oncommit={commitStagedHeight}
    />

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
          <!--
            破壊的な 2 つはセーブモードでは出さない（決定 31）。
            退避する側を選んでいる最中に、**退避されない側を不可逆に消す口**を
            すぐ隣へ並べない（どちらも git には残らない操作）。
            必要なら差分モードへ戻れば同じ一覧・同じ選択のまま押せる。
          -->
          {#if !stashMode}
            <button
              class="danger"
              disabled={app.busy || changesTotal === 0}
              title="作業ツリーの変更だけを捨てます。ステージ済みの内容は残ります。"
              onclick={() => void app.discard({ kind: 'filtered', filter: { group: 'unstaged' } })}
            >
              未ステージの変更をすべて破棄
            </button>
            <button
              class="danger"
              disabled={app.busy || (app.summary?.counts.untracked ?? 0) === 0}
              onclick={() => void app.deleteUntracked({ kind: 'filtered', filter: { group: 'untracked' } })}
            >
              未追跡をすべて削除
            </button>
          {/if}
        </div>
      </header>
      <VirtualFileList
        group="changes"
        entries={app.changes.entries}
        total={app.changes.total}
        selectedPath={app.selected?.staged === false ? app.selected.path : null}
        multiSelectedPaths={changesSelection.selected}
        onselect={(entry, event, index) => handleSelect(entry, event, index, false)}
        ondblclick={(entry) => void app.toggleStage({ path: entry.path, staged: false })}
        oncontextmenu={(entry, event, index) => handleContextMenu(entry, event, index, false)}
        onneedpage={(offset) => void app.loadMore('changes', offset)}
      />
    </section>
  </div>

  {#if stashMode}
    <StashSaveBox />
  {:else}
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
  {/if}
</div>

{#if contextMenu !== null}
  {@const menu = contextMenu}
  <FileContextMenu
    x={menu.x}
    y={menu.y}
    onclose={() => (contextMenu = null)}
    actions={[
      ...(menu.staged
        ? [
            {
              label: 'アンステージ',
              onclick: () => void app.unstage({ kind: 'paths', paths: [...stagedSelection.selected] }),
            },
          ]
        : [
            {
              label: 'ステージ',
              onclick: () => void app.stage({ kind: 'paths', paths: [...changesSelection.selected] }),
            },
            {
              label: '未ステージの変更を破棄',
              danger: true,
              onclick: () => void app.discard({ kind: 'paths', paths: [...changesSelection.selected] }),
            },
          ]),
      // 開く系は選択ではなく、右クリックした 1 件が対象
      {
        label: 'ファイルを開く',
        disabled: !existsOnDisk(menu.entry),
        onclick: () => void app.openFile(menu.entry.path),
      },
      {
        label: 'フォルダを開く',
        onclick: () => void app.showInFolder(menu.entry.path),
      },
    ]}
  />
{/if}

<style>
  .pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    /* main.panes のグリッドアイテムそのもの。min-width の既定は auto（= min-content 幅）で、
       それをヘッダの nowrap なボタン群が押し上げる。0 にしないとファイル名の行が
       差分ペインの上にはみ出して描画される。 */
    min-width: 0;
    height: 100%;
    border-right: 1px solid var(--app-border-subtle);
    overflow: hidden;
  }

  .groups {
    display: grid;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  .group {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    border-bottom: 1px solid var(--app-border-subtle);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-metric-gap);
    min-width: 0;
    padding: 6px 8px;
    background: var(--app-bg-surface);
    border-bottom: 1px solid var(--app-border-subtle);
    /* 狭めたときにボタンを縦書きへ折り返させず、見出しを縮めて端から隠す。 */
    overflow: hidden;
  }

  h2 {
    margin: 0;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
    color: var(--app-text-secondary);
    white-space: nowrap;
    /* ペインを狭めたとき、操作ボタンより先に見出しから縮ませる。 */
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /*
   * Stash 保存モードの見出し（決定 31）。アクセント色は縦帯で選択中のモードを
   * 示している色と同じなので、「いまどのモードにいるか」が 2 箇所で一致する。
   * 太さは変えない（幅が動くと一覧の行がずれて見える）。
   */
  h2.stash {
    color: var(--app-accent);
  }

  .count {
    color: var(--app-text-muted);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .actions {
    display: flex;
    flex: 0 0 auto;
    gap: 4px;
  }

  .actions button {
    flex: 0 0 auto;
    font-size: var(--app-font-size-mono);
    padding: 2px 8px;
    white-space: nowrap;
  }

  .commit {
    display: flex;
    flex: 0 0 auto;
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
