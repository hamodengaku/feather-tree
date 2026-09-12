<script lang="ts">
  /*
   * コミットログモードの下半分（決定 27）。選択中コミットの詳細。
   *
   * タブ 2 枚:
   *   コミット情報 — メタ情報（ハッシュ・作者・コミッター・日時・親）と本文、変更ファイル名の一覧
   *   変更       — 左に変更ファイルのリスト、右にその diff（#36）
   *
   * どちらのタブも、開いただけでは git を増やさない。
   * ファイル一覧（#21）はコミットを選んだ時点で 1 回取ってあり、diff は行を選んだときだけ取る。
   */
  import type { CommitFileChangeDto } from '@feathertree/ipc';
  import { app } from '../lib/appState.svelte.js';
  import PaneSplitter from '../components/PaneSplitter.svelte';
  import ReadonlyDiffView from '../components/ReadonlyDiffView.svelte';

  const commit = $derived(app.commits.find((c) => c.oid === app.selectedCommit) ?? null);
  const isMerge = $derived((commit?.parents.length ?? 0) > 1);

  /**
   * マージコミットでファイル一覧が空になるのは git の既定（`show` は -m / --cc なしで
   * 複数親の diff を出さない）。エラーではないので、そうと分かる文言を出す。
   * docs/02-git-command-map.md の #21 / #36 の注記。
   */
  const mergeEmpty = $derived(isMerge && app.commitFiles.length === 0 && !app.commitFilesLoading);

  let liveFileWidth = $state<number | null>(null);
  const fileWidth = $derived(liveFileWidth ?? app.settings?.commitFileListWidth ?? 260);

  function dateText(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso;
    const p2 = (n: number): string => String(n).padStart(2, '0');
    return `${String(at.getFullYear())}-${p2(at.getMonth() + 1)}-${p2(at.getDate())} ${p2(at.getHours())}:${p2(at.getMinutes())}:${p2(at.getSeconds())}`;
  }

  /** 状態文字の 1 文字目で色を分ける。R100 のようなスコア付きも先頭だけ見ればよい。 */
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

<div class="pane commit-detail-pane">
  <div class="tabs" role="tablist">
    <button
      role="tab"
      class:active={app.commitDetailTab === 'info'}
      aria-selected={app.commitDetailTab === 'info'}
      onclick={() => (app.commitDetailTab = 'info')}
    >
      コミット情報
    </button>
    <button
      role="tab"
      class:active={app.commitDetailTab === 'changes'}
      aria-selected={app.commitDetailTab === 'changes'}
      onclick={() => (app.commitDetailTab = 'changes')}
    >
      変更
    </button>
    {#if commit !== null}
      <span class="tab-meta">{commit.shortOid}</span>
    {/if}
  </div>

  {#if commit === null}
    <p class="empty">コミットを選択すると詳細を表示します。</p>
  {:else if app.commitDetailTab === 'info'}
    <div class="info">
      <h3>{commit.subject}</h3>
      {#if commit.body.length > 0}
        <pre class="body-text">{commit.body}</pre>
      {/if}

      <dl class="meta">
        <dt>ハッシュ</dt>
        <dd class="mono">{commit.oid}</dd>
        <dt>作者</dt>
        <dd>{commit.authorName} &lt;{commit.authorEmail}&gt; ・ {dateText(commit.authoredAt)}</dd>
        <!--
          コミッターは作者と食い違うことがある（rebase / cherry-pick / 代理コミット）。
          同じときは 1 行に潰さず常に出す。「同じであること」自体が読み取りたい情報なので。
        -->
        <dt>コミッター</dt>
        <dd>
          {commit.committerName} &lt;{commit.committerEmail}&gt; ・ {dateText(commit.committedAt)}
        </dd>
        <dt>親</dt>
        <dd class="mono">
          {#if commit.parents.length === 0}
            なし（ルートコミット）
          {:else}
            {commit.parents.map((p) => p.slice(0, 7)).join('  ')}
            {#if isMerge}<span class="note">（マージコミット）</span>{/if}
          {/if}
        </dd>
      </dl>

      <h4>
        変更ファイル
        {#if app.commitFiles.length > 0}<span class="count">{app.commitFiles.length} 件</span>{/if}
      </h4>
      {#if app.commitFilesLoading}
        <p class="empty">読み込み中…</p>
      {:else if mergeEmpty}
        <p class="empty">マージコミットのため変更ファイルはありません（git の既定）。</p>
      {:else if app.commitFiles.length === 0}
        <p class="empty">変更ファイルはありません。</p>
      {:else}
        <ul class="files">
          {#each app.commitFiles as file (file.path)}
            <li>
              <span class="status {statusClass(file.status)}">{file.status}</span>
              <span class="path">{labelOf(file)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else}
    <!-- 「変更」タブ。左＝ファイルリスト、右＝その diff -->
    <div class="changes" style:grid-template-columns="{fileWidth}px 6px minmax(200px, 1fr)">
      <div class="file-list">
        {#if app.commitFilesLoading}
          <p class="empty">読み込み中…</p>
        {:else if mergeEmpty}
          <p class="empty">マージコミットのため変更ファイルはありません（git の既定）。</p>
        {:else if app.commitFiles.length === 0}
          <p class="empty">変更ファイルはありません。</p>
        {:else}
          <div role="listbox" aria-label="変更ファイル">
            {#each app.commitFiles as file (file.path)}
              <div
                class="file-row"
                class:selected={file.path === app.selectedCommitPath}
                role="option"
                aria-selected={file.path === app.selectedCommitPath}
                tabindex="-1"
                title={labelOf(file)}
                onclick={() => void app.selectCommitPath(file.path)}
                onkeydown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void app.selectCommitPath(file.path);
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
          void app.setCommitFileListWidth(w);
        }}
      />

      <div class="diff-side">
        <ReadonlyDiffView
          diff={app.commitDiff}
          loading={app.commitDiffLoading}
          emptyText={app.selectedCommitPath === null
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

  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
    padding: 4px 8px 0;
    background: var(--app-bg-surface);
    border-bottom: 1px solid var(--app-border-subtle);
  }

  /*
    アプリヘッダのタブ段と同じ考え方で、選択中のタブだけ下の面と地続きに見せる。
    ただしこちらはウィンドウのドラッグ領域ではないので no-drag は要らない。
  */
  .tabs button {
    background: none;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: var(--app-metric-radius) var(--app-metric-radius) 0 0;
    padding: 3px 12px;
    color: var(--app-text-secondary);
  }

  .tabs button:hover:not(.active) {
    background: var(--app-bg-hover);
  }

  .tabs button.active {
    background: var(--app-bg-app);
    border-color: var(--app-border-subtle);
    color: var(--app-text-primary);
    font-weight: 600;
  }

  .tab-meta {
    margin-left: auto;
    color: var(--app-text-muted);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .empty {
    margin: 16px;
    color: var(--app-text-muted);
  }

  .info {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 10px 12px;
  }

  .info h3 {
    margin: 0 0 8px;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
  }

  .info h4 {
    margin: 14px 0 6px;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
    border-top: 1px solid var(--app-border-subtle);
    padding-top: 10px;
  }

  .count {
    margin-left: 6px;
    color: var(--app-text-muted);
    font-weight: 400;
    font-size: var(--app-font-size-mono);
  }

  /* コミット本文。git のメッセージは整形済みなので改行と空白をそのまま出す。 */
  .body-text {
    margin: 0 0 10px;
    padding: 8px 10px;
    background: var(--app-bg-raised);
    border-radius: var(--app-metric-radius);
    color: var(--app-text-secondary);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ラベルと値の 2 列。ラベル幅を固定して値の左端を揃える。 */
  .meta {
    display: grid;
    grid-template-columns: 88px 1fr;
    gap: 2px var(--app-metric-gap);
    margin: 0;
  }

  .meta dt {
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .meta dd {
    margin: 0;
    min-width: 0;
    color: var(--app-text-secondary);
    word-break: break-all;
  }

  .meta .mono {
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .note {
    color: var(--app-text-muted);
  }

  .files {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .files li,
  .file-row {
    display: flex;
    align-items: center;
    gap: var(--app-metric-gap);
    height: var(--app-metric-row-height);
    padding: 0 8px;
    white-space: nowrap;
  }

  .file-row {
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

  .diff-side {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
</style>
