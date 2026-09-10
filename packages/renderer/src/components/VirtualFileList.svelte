<script lang="ts">
  import type { FileEntryDto, StatusGroupDto } from '@feathertree/ipc';
  import { computeWindow } from '@feathertree/base-ui';
  import FileRow from './FileRow.svelte';

  interface Props {
    group: StatusGroupDto;
    entries: (FileEntryDto | undefined)[];
    total: number;
    selectedPath: string | null;
    multiSelectedPaths: ReadonlySet<string>;
    onselect: (entry: FileEntryDto, event: MouseEvent | KeyboardEvent, index: number) => void;
    ondblclick: (entry: FileEntryDto) => void;
    oncontextmenu: (entry: FileEntryDto, event: MouseEvent, index: number) => void;
    onneedpage: (offset: number) => void;
  }

  const {
    group,
    entries,
    total,
    selectedPath,
    multiSelectedPaths,
    onselect,
    ondblclick,
    oncontextmenu,
    onneedpage,
  }: Props = $props();

  const ROW_HEIGHT = 22;

  let scrollTop = $state(0);
  let viewportHeight = $state(0);

  const view = $derived(computeWindow(total, scrollTop, viewportHeight, { rowHeight: ROW_HEIGHT }));

  /**
   * 可視範囲だけを DOM に出す。1 万件でも DOM ノードは 100 個以下
   * （docs/01-architecture.md 12 章の性能目標）。
   */
  const visible = $derived(
    Array.from({ length: Math.max(0, view.endIndex - view.startIndex) }, (_, i) => ({
      index: view.startIndex + i,
      entry: entries[view.startIndex + i],
    })),
  );

  // 未取得の範囲に入ったら次のページを要求する
  $effect(() => {
    if (view.endIndex > view.startIndex && entries[view.startIndex] === undefined) {
      onneedpage(view.startIndex);
    }
  });

  function handleScroll(event: Event): void {
    const target = event.currentTarget as HTMLElement;
    scrollTop = target.scrollTop;
    viewportHeight = target.clientHeight;
  }
</script>

<div class="viewport" role="listbox" aria-label={group} onscroll={handleScroll} bind:clientHeight={viewportHeight}>
  <div class="spacer" style:height={view.totalHeight + 'px'}>
    <div class="rows" style:transform={'translateY(' + view.paddingTop + 'px)'}>
      {#each visible as row (row.index)}
        {#if row.entry === undefined}
          <div class="placeholder">読み込み中…</div>
        {:else}
          <FileRow
            entry={row.entry}
            selected={row.entry.path === selectedPath}
            multiSelected={multiSelectedPaths.has(row.entry.path)}
            onselect={(event) => {
              if (row.entry !== undefined) onselect(row.entry, event, row.index);
            }}
            ondblclick={() => {
              if (row.entry !== undefined) ondblclick(row.entry);
            }}
            oncontextmenu={(event) => {
              if (row.entry !== undefined) oncontextmenu(row.entry, event, row.index);
            }}
          />
        {/if}
      {/each}
    </div>
  </div>
</div>

<style>
  .viewport {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
  }

  .spacer {
    position: relative;
  }

  .rows {
    position: absolute;
    inset: 0 0 auto 0;
    will-change: transform;
  }

  .placeholder {
    height: var(--app-metric-row-height);
    padding: 0 8px;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }
</style>
