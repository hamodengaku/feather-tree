<script lang="ts">
  /*
   * Excel グリッドのセルの入力欄（docs/07 7.1・7.3）。左右のグリッドとマージ後のプレビューで共有する。
   *
   * 出たら焦点を移し、カーソルを末尾へ。Enter / Tab で決定、Esc で取り消し、欄の外を押したら決定。
   * 打鍵・押下はグリッドへ泡立たせない（グリッドの打鍵で編集を始め直したり、選択が動いたりしないように）。
   */
  import type { Box } from '../lib/excelGrid.js';

  interface Props {
    value: string;
    box: Box;
    oncommit?: ((value: string) => void) | undefined;
    oncancel?: (() => void) | undefined;
  }

  const { value, box, oncommit, oncancel }: Props = $props();

  function focusEditor(el: HTMLInputElement): void {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  function key(e: KeyboardEvent): void {
    const target = e.currentTarget as HTMLInputElement;
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      oncommit?.(target.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      oncancel?.();
    }
  }
</script>

<input
  class="editor"
  aria-label="セルの値（Enter で決定・Esc で取り消し）"
  {value}
  style:top={box.top + 'px'}
  style:left={box.left + 'px'}
  style:min-width={box.width + 'px'}
  style:height={box.height + 'px'}
  use:focusEditor
  onkeydown={key}
  onmousedown={(e) => e.stopPropagation()}
  ondblclick={(e) => e.stopPropagation()}
  onblur={(e) => oncommit?.((e.currentTarget as HTMLInputElement).value)}
/>

<style>
  .editor {
    position: absolute;
    box-sizing: border-box;
    z-index: 4;
    padding: 0 3px;
    border: 2px solid var(--app-accent);
    background: var(--app-excel-paper);
    color: var(--app-excel-ink);
    font: inherit;
    font-size: var(--cell-font);
    outline: none;
  }
</style>
