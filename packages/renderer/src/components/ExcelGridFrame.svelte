<script lang="ts">
  /*
   * Excel グリッドの枠（決定 33）。左右のグリッド（ExcelGrid）とマージ後のプレビュー（ExcelPreviewGrid）で共有する。
   *
   * 持つもの: 角・列見出し・行見出し・スクロールする本体・キャンバス、その配置と共通の見た目。
   * 列見出し・行見出しは本体のスクロールに合わせて transform で動かす（sticky の入れ子を避ける）。
   * 見出しとセルの中身は、使う側が snippet で差し込む（どの行・列を描くか・印は使う側が決める）。
   *
   * 差し込まれる中身は使う側のスコープの要素なので、共通の見た目（.ch / .rh / .cell / .row-tone の土台）は
   * この枠の中に限った :global で当てる。印などの上書きは使う側が持つ。
   */
  import type { Snippet } from 'svelte';
  import { HEADER_HEIGHT } from '../lib/excelGrid.js';

  interface Props {
    rowHeaderWidth: number;
    /** セルの既定の文字の大きさ（pt。ブックの既定のフォント）。 */
    fontPt: number;
    totalWidth: number;
    totalHeight: number;
    label: string;
    /** スクロールする本体。親がスクロールを写すのに使う。 */
    viewport?: HTMLDivElement | null;
    /** キャンバス（押した位置の行・列を引くのに使う）。 */
    canvas?: HTMLDivElement | null;
    scrollTop?: number;
    scrollLeft?: number;
    viewportWidth?: number;
    viewportHeight?: number;
    onscroll?: ((top: number, left: number) => void) | undefined;
    onmousedown?: ((e: MouseEvent) => void) | undefined;
    onmousemove?: ((e: MouseEvent) => void) | undefined;
    oncontextmenu?: ((e: MouseEvent) => void) | undefined;
    ondblclick?: ((e: MouseEvent) => void) | undefined;
    colHeaders: Snippet;
    rowHeaders: Snippet;
    children: Snippet;
  }

  let {
    rowHeaderWidth,
    fontPt,
    totalWidth,
    totalHeight,
    label,
    viewport = $bindable(null),
    canvas = $bindable(null),
    scrollTop = $bindable(0),
    scrollLeft = $bindable(0),
    viewportWidth = $bindable(0),
    viewportHeight = $bindable(0),
    onscroll,
    onmousedown,
    onmousemove,
    oncontextmenu,
    ondblclick,
    colHeaders,
    rowHeaders,
    children,
  }: Props = $props();

  function handleScroll(event: Event): void {
    const target = event.currentTarget as HTMLDivElement;
    scrollTop = target.scrollTop;
    scrollLeft = target.scrollLeft;
    onscroll?.(scrollTop, scrollLeft);
  }
</script>

<div
  class="grid"
  style:--row-header={rowHeaderWidth + 'px'}
  style:--col-header={HEADER_HEIGHT + 'px'}
  style:--cell-font={Math.min(24, Math.max(6, fontPt)) + 'pt'}
>
  <div class="corner" aria-hidden="true"></div>

  <div class="col-header" aria-hidden="true">
    <div class="col-header-inner" style:width={totalWidth + 'px'} style:transform={'translateX(' + -scrollLeft + 'px)'}>
      {@render colHeaders()}
    </div>
  </div>

  <div class="row-header" aria-hidden="true">
    <div class="row-header-inner" style:height={totalHeight + 'px'} style:transform={'translateY(' + -scrollTop + 'px)'}>
      {@render rowHeaders()}
    </div>
  </div>

  <div
    class="viewport"
    role="grid"
    tabindex="-1"
    aria-label={label}
    bind:this={viewport}
    bind:clientWidth={viewportWidth}
    bind:clientHeight={viewportHeight}
    onscroll={handleScroll}
  >
    <!-- 押した・動かした・右クリックした位置から行と列を引く（埋め行・結合セルでも同じに扱う） -->
    <div
      class="canvas"
      role="presentation"
      style:width={totalWidth + 'px'}
      style:height={totalHeight + 'px'}
      bind:this={canvas}
      {onmousedown}
      {onmousemove}
      {oncontextmenu}
      {ondblclick}
    >
      {@render children()}
    </div>
  </div>
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: var(--row-header) minmax(0, 1fr);
    grid-template-rows: var(--col-header) minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    background: var(--app-excel-paper);
    color: var(--app-excel-ink);
    font-family: var(--app-font-ui);
    font-size: 12px;
  }

  .corner {
    background: var(--app-bg-raised);
    border-right: 1px solid var(--app-border-strong);
    border-bottom: 1px solid var(--app-border-strong);
  }

  .col-header,
  .row-header {
    position: relative;
    overflow: hidden;
    background: var(--app-bg-raised);
    color: var(--app-text-secondary);
  }

  .col-header {
    border-bottom: 1px solid var(--app-border-strong);
  }

  .row-header {
    border-right: 1px solid var(--app-border-strong);
  }

  .col-header-inner,
  .row-header-inner {
    position: absolute;
    inset: 0 auto auto 0;
    will-change: transform;
  }

  .row-header-inner {
    width: 100%;
  }

  .col-header-inner {
    height: 100%;
  }

  .viewport {
    position: relative;
    overflow: auto;
    min-width: 0;
    min-height: 0;
    outline: none;
  }

  .canvas {
    position: relative;
  }

  /* ---- 差し込まれる中身の土台（印などの上書きは使う側） ---- */

  .grid :global(.ch),
  .grid :global(.rh) {
    position: absolute;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    white-space: nowrap;
    font-size: 11px;
  }

  .grid :global(.ch) {
    top: 0;
    height: 100%;
    border-right: 1px solid var(--app-border-subtle);
  }

  .grid :global(.rh) {
    left: 0;
    width: 100%;
    border-bottom: 1px solid var(--app-border-subtle);
  }

  .grid :global(.row-tone) {
    position: absolute;
    left: 0;
    right: 0;
    box-sizing: border-box;
  }

  /*
   * セルは縦向きの flex の箱にして、縦の配置（Excel の既定は下寄せ）を justify-content で表す。
   * 横の配置・色・罫線などの書式は、検証済みの値だけで組んだ style 属性で上書きする（lib/excelStyle.ts）。
   */
  .grid :global(.cell) {
    position: absolute;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    padding: 0 3px;
    border-right: 1px solid var(--app-excel-grid-line);
    border-bottom: 1px solid var(--app-excel-grid-line);
    overflow: hidden;
    white-space: pre;
    text-overflow: clip;
    font-size: var(--cell-font);
    line-height: 1.25;
    cursor: cell;
    user-select: none;
  }
</style>
