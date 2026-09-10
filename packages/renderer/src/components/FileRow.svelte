<script lang="ts">
  import type { FileEntryDto } from '@feathertree/ipc';

  interface Props {
    entry: FileEntryDto;
    selected: boolean;
    multiSelected: boolean;
    onselect: (event: MouseEvent | KeyboardEvent) => void;
    ondblclick: () => void;
    oncontextmenu: (event: MouseEvent) => void;
  }

  const { entry, selected, multiSelected, onselect, ondblclick, oncontextmenu }: Props = $props();

  /** 状態コードを 1 文字の記号と色に写す。 */
  function marker(e: FileEntryDto): { label: string; kind: string } {
    if (e.kind === 'untracked') return { label: '?', kind: 'untracked' };
    if (e.kind === 'unmerged') return { label: '!', kind: 'conflict' };
    const code = e.staged !== '.' ? e.staged : e.worktree;
    switch (code) {
      case 'A':
        return { label: 'A', kind: 'added' };
      case 'D':
        return { label: 'D', kind: 'removed' };
      case 'R':
      case 'C':
        return { label: code, kind: 'modified' };
      default:
        return { label: 'M', kind: 'modified' };
    }
  }

  const m = $derived(marker(entry));
  const dir = $derived(entry.path.slice(0, entry.path.lastIndexOf('/') + 1));
  const name = $derived(entry.path.slice(entry.path.lastIndexOf('/') + 1));
  const tooltip = $derived(
    entry.origPath === undefined ? entry.path : entry.origPath + ' -> ' + entry.path,
  );
</script>

<!--
  ファイル名はテキスト補間のみで描画する。
  リポジトリ由来の文字列は信頼できない入力なので {@html} は使わない
  （docs/01-architecture.md 10 章。ESLint の svelte/no-at-html-tags でも禁止）。
-->
<div
  class="row"
  class:selected
  class:multi-selected={multiSelected}
  role="option"
  aria-selected={selected}
  tabindex="-1"
  onclick={onselect}
  ondblclick={ondblclick}
  oncontextmenu={(e) => {
    e.preventDefault();
    oncontextmenu(e);
  }}
  onkeydown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') onselect(e);
  }}
>
  <span class="marker {m.kind}">{m.label}</span>
  <span class="path" title={tooltip}><span class="dir">{dir}</span>{name}</span>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--app-metric-row-height);
    padding: 0 8px;
    cursor: default;
    white-space: nowrap;
    user-select: none;
  }

  .row:hover {
    background: var(--app-bg-hover);
  }

  .row.selected {
    background: var(--app-bg-selected);
  }

  .row.multi-selected {
    background: var(--app-bg-hover);
    outline: 1px solid var(--app-border-strong);
    outline-offset: -1px;
  }

  .marker {
    flex: 0 0 auto;
    width: 12px;
    text-align: center;
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    font-weight: 600;
  }

  .marker.added {
    color: var(--app-text-added);
  }
  .marker.removed {
    color: var(--app-text-removed);
  }
  .marker.modified {
    color: var(--app-text-modified);
  }
  .marker.untracked {
    color: var(--app-text-untracked);
  }
  .marker.conflict {
    color: var(--app-text-conflict);
  }

  .path {
    flex: 0 0 auto;
  }

  .dir {
    color: var(--app-text-muted);
  }
</style>
