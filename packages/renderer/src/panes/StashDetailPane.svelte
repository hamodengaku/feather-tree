<script lang="ts">
  /*
   * Stash 解放モードの下半分（決定 31）。選んだ stash の中身。
   *
   * 形はコミット詳細ペインの「変更」タブと同じ（左＝変更ファイル、右＝その diff）。
   * **タブは持たない**——stash にはメタ情報がほとんど無く（作者もコミッターも自分、
   * 親も内部の都合）、1 枚に収まるものをタブで隠す理由が無い。
   *
   * 開いただけでは git を増やさない。ファイル一覧（#45）は stash を選んだ時点で
   * 1 回取ってあり、diff（#46）は行を選んだときだけ取る。
   */
  import type { CommitFileChangeDto } from '@feathertree/ipc';
  import { app } from '../lib/appState.svelte.js';
  import PaneSplitter from '../components/PaneSplitter.svelte';
  import ReadonlyDiffView from '../components/ReadonlyDiffView.svelte';

  const entry = $derived(app.selectedStashEntry);

  let liveFileWidth = $state<number | null>(null);
  const fileWidth = $derived(liveFileWidth ?? app.settings?.stashFileListWidth ?? 260);

  /** 状態文字の 1 文字目で色を分ける（コミット詳細ペインと同じ規則）。 */
  function statusClass(status: string): string {
    const head = status.charAt(0).toUpperCase();
    if (head === 'A') return 'added';
    if (head === 'D') return 'removed';
    if (head === 'R' || head === 'C') return 'moved';
    return 'modified';
  }

  function labelOf(file: CommitFileChangeDto): string {
    return file.origPath === null ? file.path : `${file.origPath} → ${file.path}`;
  }
</script>

<div class="pane stash-detail-pane">
  <div class="head">
    {#if entry === null}
      <span class="title muted">stash を選択すると中身を表示します。</span>
    {:else}
      <span class="ref">{entry.ref}</span>
      <span class="title" title={entry.message}>{entry.message}</span>
      <span class="count">
        {#if app.stashFiles.length > 0}{app.stashFiles.length} ファイル{/if}
      </span>
    {/if}
  </div>

  {#if entry === null}
    <p class="empty">
      上の一覧から stash を選んでください。右クリックでブランチへの展開・破棄ができます。
    </p>
  {:else}
    <div class="changes" style:grid-template-columns="{fileWidth}px 6px minmax(200px, 1fr)">
      <div class="file-list">
        {#if app.stashFilesLoading}
          <p class="empty">読み込み中…</p>
        {:else if app.stashFiles.length === 0}
          <p class="empty">変更ファイルはありません。</p>
        {:else}
          <div role="listbox" aria-label="stash の変更ファイル">
            {#each app.stashFiles as file (file.path)}
              <div
                class="file-row"
                class:selected={file.path === app.selectedStashPath}
                role="option"
                aria-selected={file.path === app.selectedStashPath}
                tabindex="-1"
                title={labelOf(file)}
                onclick={() => void app.selectStashPath(file.path)}
                onkeydown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void app.selectStashPath(file.path);
                  }
                }}
              >
                <span class="status {statusClass(file.status)}">{file.status}</span>
                <span class="path">{labelOf(file)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <PaneSplitter
        value={fileWidth}
        min={120}
        max={1200}
        onchange={(w) => (liveFileWidth = w)}
        oncommit={(w) => {
          liveFileWidth = null;
          void app.setStashFileListWidth(w);
        }}
      />

      <div class="diff-side">
        <ReadonlyDiffView
          diff={app.stashDiff}
          loading={app.stashDiffLoading}
          emptyText={app.selectedStashPath === null
            ? 'ファイルを選択すると差分を表示します。'
            : '差分はありません。'}
        />
      </div>
    </div>
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

  /* コミット詳細ペインのタブ段と同じ高さ・同じ面に座る 1 行。 */
  .head {
    display: flex;
    align-items: center;
    gap: var(--app-metric-gap);
    flex: 0 0 auto;
    min-width: 0;
    padding: 6px 8px;
    background: var(--app-bg-surface);
    border-bottom: 1px solid var(--app-border-subtle);
  }

  .ref {
    flex: 0 0 auto;
    color: var(--app-text-muted);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title.muted {
    color: var(--app-text-muted);
  }

  .count {
    flex: 0 0 auto;
    color: var(--app-text-muted);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .empty {
    margin: 16px;
    color: var(--app-text-muted);
  }

  .changes {
    flex: 1 1 auto;
    display: grid;
    min-height: 0;
  }

  .file-list {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    border-right: 1px solid var(--app-border-subtle);
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: var(--app-metric-gap);
    height: var(--app-metric-row-height);
    padding: 0 8px;
    white-space: nowrap;
    cursor: default;
  }

  .file-row:hover {
    background: var(--app-bg-hover);
  }

  .file-row.selected {
    background: var(--app-bg-selected);
  }

  .file-row:focus-visible {
    outline: 1px solid var(--app-accent);
    outline-offset: -1px;
  }

  .status {
    flex: 0 0 auto;
    width: 34px;
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .status.added {
    color: var(--app-text-added);
  }

  .status.removed {
    color: var(--app-text-removed);
  }

  .status.modified {
    color: var(--app-text-modified);
  }

  .status.moved {
    color: var(--app-text-untracked);
  }

  .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .diff-side {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
</style>
