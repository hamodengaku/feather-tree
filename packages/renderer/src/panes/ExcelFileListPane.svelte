<script lang="ts">
  /*
   * Excel 差分モード（決定 33）の左の一覧。ブランチペインの位置に座り、縦帯の折り畳みボタンで畳める。
   *
   * 出すのは変更のある .xlsx / .xlsm（と、案内だけを出す .xls / .xlsb）。main が status の
   * スナップショットを拡張子で絞ったもので、**git は 0 プロセス**。`~$` のロックファイルは main が除く。
   * 行の描画は作業ツリーペインと同じ FileRow（状態の印の付け方を揃える）。
   */
  import type { ExcelFileEntryDto } from '@feathertree/ipc';
  import { computeWindow } from '@feathertree/base-ui';
  import FileRow from '../components/FileRow.svelte';
  import { app } from '../lib/appState.svelte.js';

  const ex = app.excel;
  const ROW_HEIGHT = 22;
  const NO_MULTI: ReadonlySet<string> = new Set();

  let scrollTop = $state(0);
  let viewportHeight = $state(0);

  const files = $derived(ex.files);
  const view = $derived(computeWindow(files.length, scrollTop, viewportHeight, { rowHeight: ROW_HEIGHT }));
  const visible = $derived(files.slice(view.startIndex, view.endIndex));

  function choose(entry: ExcelFileEntryDto): void {
    void ex.select(entry.path);
  }
</script>

<section class="excel-files" aria-label="Excel ファイル">
  <header>
    <h2>Excel</h2>
    <span class="meta" title="比較は常に HEAD と作業ツリー（ステージ済み／未ステージを区別しません）">HEAD ↔ 作業ツリー</span>
    <span class="count">{files.length}</span>
  </header>

  {#if !ex.filesLoaded}
    <p class="empty">読み込み中…</p>
  {:else if files.length === 0}
    <p class="empty">変更のある Excel / CSV ファイルはありません。</p>
  {:else}
    <div
      class="viewport"
      role="listbox"
      aria-label="変更のある Excel / CSV ファイル"
      bind:clientHeight={viewportHeight}
      onscroll={(e) => (scrollTop = (e.currentTarget as HTMLElement).scrollTop)}
    >
      <div class="spacer" style:height={view.totalHeight + 'px'}>
        <div class="rows" style:transform={'translateY(' + view.paddingTop + 'px)'}>
          {#each visible as entry (entry.path)}
            <div class:unopenable={!entry.openable} title={entry.openable ? undefined : 'この形式（.xls / .xlsb）は表示できません'}>
              <FileRow
                {entry}
                selected={entry.path === ex.selectedPath}
                multiSelected={NO_MULTI.has(entry.path)}
                onselect={() => choose(entry)}
                ondblclick={() => choose(entry)}
                oncontextmenu={() => undefined}
              />
            </div>
          {/each}
        </div>
      </div>
    </div>
    {#if ex.filesTruncated}
      <p class="notice">一覧が長すぎるため、先頭の一部だけを出しています。</p>
    {/if}
  {/if}
</section>

<style>
  .excel-files {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
    background: var(--app-bg-surface);
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--app-border-subtle);
    white-space: nowrap;
  }

  h2 {
    margin: 0;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
  }

  .meta {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .count {
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .viewport {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  .spacer {
    position: relative;
  }

  .rows {
    position: absolute;
    inset: 0 0 auto 0;
    will-change: transform;
  }

  .unopenable {
    opacity: 0.55;
  }

  .empty {
    margin: 0;
    padding: 12px;
    color: var(--app-text-secondary);
    font-size: var(--app-font-size-ui);
  }

  .notice {
    margin: 0;
    padding: 4px 8px;
    border-top: 1px solid var(--app-border-subtle);
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }
</style>
