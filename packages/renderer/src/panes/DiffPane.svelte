<script lang="ts">
  import { app } from '../lib/appState.svelte.js';

  const diff = $derived(app.diff);
  const lineCount = $derived(diff?.hunks.reduce((n, h) => n + h.lines.length, 0) ?? 0);
</script>

<div class="pane">
  <header>
    <h2>{app.selected?.path ?? '差分'}</h2>
    {#if diff !== null}
      <span class="meta">
        {app.selected?.staged === true ? 'ステージ済み' : '未ステージ'}
        {#if diff.truncated}・打ち切り{/if}
        {#if lineCount > 0}・{lineCount} 行{/if}
      </span>
    {/if}
  </header>

  <div class="body">
    {#if app.diffLoading}
      <p class="empty">読み込み中…</p>
    {:else if app.selected === null}
      <p class="empty">ファイルを選択すると差分を表示します。</p>
    {:else if diff === null}
      <p class="empty">差分はありません。</p>
    {:else if diff.binary}
      <p class="empty">バイナリファイルのため差分を表示できません。</p>
    {:else if diff.hunks.length === 0}
      <p class="empty">差分はありません。</p>
    {:else}
      <!-- Unified 表示。パーサと描画を分離してあるので side-by-side は後付けできる -->
      <div class="diff">
        {#each diff.hunks as hunk (hunk.header)}
          <div class="hunk-header">{hunk.header}</div>
          {#each hunk.lines as line, i (i)}
            <div class="line {line.kind}">
              <span class="no">{line.oldLineNo ?? ''}</span>
              <span class="no">{line.newLineNo ?? ''}</span>
              <span class="sign">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span>
              <span class="text">{line.text}</span>
            </div>
          {/each}
        {/each}
        {#if diff.truncated}
          <div class="hunk-header">これ以降は行数上限により省略されました。</div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: var(--app-metric-gap);
    padding: 6px 8px;
    background: var(--app-bg-surface);
    border-bottom: 1px solid var(--app-border-subtle);
    overflow: hidden;
  }

  h2 {
    margin: 0;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    flex: 0 0 auto;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  .empty {
    margin: 16px;
    color: var(--app-text-muted);
  }

  .diff {
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    line-height: 17px;
    min-width: max-content;
  }

  .hunk-header {
    padding: 2px 8px;
    color: var(--app-text-secondary);
    background: var(--app-bg-raised);
    border-top: 1px solid var(--app-border-subtle);
    border-bottom: 1px solid var(--app-border-subtle);
  }

  .line {
    display: flex;
    white-space: pre;
  }

  .line.added {
    background: var(--app-diff-added-bg);
  }

  .line.removed {
    background: var(--app-diff-removed-bg);
  }

  .no {
    flex: 0 0 auto;
    width: 46px;
    padding-right: 8px;
    text-align: right;
    color: var(--app-text-muted);
    user-select: none;
  }

  .sign {
    flex: 0 0 auto;
    width: 14px;
    text-align: center;
    user-select: none;
  }

  .line.added .sign,
  .line.added .text {
    color: var(--app-text-added);
  }

  .line.removed .sign,
  .line.removed .text {
    color: var(--app-text-removed);
  }

  .line.no-newline .text {
    color: var(--app-text-muted);
    font-style: italic;
  }
</style>
