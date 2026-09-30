<script lang="ts">
  /*
   * Excel 差分モード（決定 33）のグリッド 1 枚（旧版または新版）。
   *
   * **幾何は新旧で同一**（main から来る ExcelSheetLayoutDto を共有する）ので、行の高さ・列の幅の
   * 累積和は親（ExcelPane）が 1 回だけ作って両方に渡す。スクロールの同期も親が受け持つ
   * （このグリッドは自分のスクロール位置を親へ知らせるだけ）。
   *
   * 見えている行・列だけを描く（可変サイズの仮想化。base-ui の rangeAtOffset）。空のセルも枠線の
   * ために箱を置くが、1080p の画面で 1 枚あたり数百個に収まる。
   *
   * 列見出し・行見出しは本体のスクロールに合わせて transform で動かす（sticky の入れ子を避ける）。
   * 文字はすべてテキスト補間で出す（{@html} は使わない。ファイルの中身は信頼できない入力）。
   */
  import type { ExcelRowDto, ExcelRowSideDto, ExcelSheetLayoutDto } from '@feathertree/ipc';
  import { untrack } from 'svelte';
  import { rangeAtOffset } from '@feathertree/base-ui';
  import {
    HEADER_HEIGHT,
    ROW_ADDED,
    ROW_REMOVED,
    cellIndex,
    columnLabel,
    coveredCells,
    mergeRects,
    rowHiddenSomewhere,
    visibleMerges,
    type MergeRect,
  } from '../lib/excelGrid.js';
  import type { ExcelSelection } from '../lib/excelState.svelte.js';
  import { cellCss, styleIndexFor, type CellCss } from '../lib/excelStyle.js';

  interface Props {
    side: 'old' | 'new';
    layout: ExcelSheetLayoutDto;
    rowOffsets: Float64Array;
    colOffsets: Float64Array;
    rowHeaderWidth: number;
    rows: ReadonlyMap<number, ExcelRowDto>;
    selection: ExcelSelection | null;
    /** このグリッドの本体（スクロールする要素）。親がスクロールを写すのに使う。 */
    viewport?: HTMLDivElement | null;
    onscroll: (top: number, left: number) => void;
    onneed: (start: number, end: number) => void;
    onselect: (row: number, col: number) => void;
  }

  let {
    side,
    layout,
    rowOffsets,
    colOffsets,
    rowHeaderWidth,
    rows,
    selection,
    viewport = $bindable(null),
    onscroll,
    onneed,
    onselect,
  }: Props = $props();

  let scrollTop = $state(0);
  let scrollLeft = $state(0);
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);

  const totalHeight = $derived(rowOffsets[rowOffsets.length - 1] ?? 0);
  const totalWidth = $derived(colOffsets[colOffsets.length - 1] ?? 0);
  const rowRange = $derived(rangeAtOffset(rowOffsets, scrollTop, viewportHeight, 3));
  const colRange = $derived(rangeAtOffset(colOffsets, scrollLeft, viewportWidth, 2));

  /** 見えている行・列（高さ・幅 0 の非表示は除く）。 */
  const visibleRows = $derived.by(() => {
    const out: number[] = [];
    for (let r = rowRange.start; r < rowRange.end; r += 1) {
      if ((rowOffsets[r + 1] ?? 0) > (rowOffsets[r] ?? 0)) out.push(r);
    }
    return out;
  });
  const visibleCols = $derived.by(() => {
    const out: number[] = [];
    for (let c = colRange.start; c < colRange.end; c += 1) {
      if ((colOffsets[c + 1] ?? 0) > (colOffsets[c] ?? 0)) out.push(c);
    }
    return out;
  });

  const merges = $derived(mergeRects(side === 'old' ? layout.oldMerges : layout.newMerges));
  const shownMerges = $derived(visibleMerges(merges, rowRange.start, rowRange.end, colRange.start, colRange.end));
  const covered = $derived(coveredCells(shownMerges));

  // 見えている範囲の行を取りに行く（取得済みのページは ExcelState が飛ばす）。
  // 依存は見えている範囲だけにする。取得の状態を依存にすると、失敗し続けるページを取り直し続ける
  $effect(() => {
    const start = rowRange.start;
    const end = rowRange.end;
    untrack(() => onneed(start, end));
  });

  function handleScroll(event: Event): void {
    const target = event.currentTarget as HTMLDivElement;
    scrollTop = target.scrollTop;
    scrollLeft = target.scrollLeft;
    onscroll(scrollTop, scrollLeft);
  }

  function sideOf(r: number): ExcelRowSideDto | null {
    const row = rows.get(r);
    if (row === undefined) return null;
    return side === 'old' ? row.old : row.new;
  }

  /** その側の行番号（無い側は -1）。 */
  function sideRow(r: number): number {
    return (side === 'old' ? layout.oldRow[r] : layout.newRow[r]) ?? -1;
  }

  function cellText(r: number, c: number): { text: string; kind: number; style: number } | null {
    const s = sideOf(r);
    const i = cellIndex(s, c);
    if (s === null || i < 0) return null;
    return { text: s.text[i] ?? '', kind: s.kind[i] ?? 0, style: s.style[i] ?? 0 };
  }

  /* 書式（M2）。セル → 行 → 列の順に効く書式を引き、検証済みの CSS にする */
  const styles = $derived(side === 'old' ? layout.oldStyles : layout.newStyles);
  const rowStyles = $derived(side === 'old' ? layout.oldRowStyle : layout.newRowStyle);
  const colStyles = $derived(side === 'old' ? layout.oldColStyle : layout.newColStyle);
  const defaultPt = $derived(side === 'old' ? layout.oldDefaultFontPt : layout.newDefaultFontPt);

  function cssFor(r: number, c: number, cell: { kind: number; style: number } | null): CellCss {
    const index = styleIndexFor(cell?.style, rowStyles[r] ?? -1, colStyles[c] ?? -1);
    return cellCss(styles[index], cell?.kind ?? 0, defaultPt);
  }

  function isChanged(r: number, c: number): boolean {
    return rows.get(r)?.changedCols.includes(c) === true;
  }

  /** 行の地の色の種類。片側に無い行（埋め行）・追加 / 削除の行。 */
  function rowTone(r: number): string {
    if (sideRow(r) < 0) return 'filler';
    const state = layout.rowState[r] ?? 0;
    if (state === ROW_ADDED && side === 'new') return 'added';
    if (state === ROW_REMOVED && side === 'old') return 'removed';
    return '';
  }

  function top(r: number): number {
    return rowOffsets[r] ?? 0;
  }
  function height(r: number): number {
    return (rowOffsets[r + 1] ?? 0) - (rowOffsets[r] ?? 0);
  }
  function left(c: number): number {
    return colOffsets[c] ?? 0;
  }
  function width(c: number): number {
    return (colOffsets[c + 1] ?? 0) - (colOffsets[c] ?? 0);
  }
  function mergeBox(m: MergeRect): { top: number; left: number; width: number; height: number } {
    return {
      top: top(m.r1),
      left: left(m.c1),
      width: (colOffsets[m.c2 + 1] ?? 0) - left(m.c1),
      height: (rowOffsets[m.r2 + 1] ?? 0) - top(m.r1),
    };
  }

  const selectionBox = $derived.by(() => {
    if (selection === null || selection.row >= layout.rowCount || selection.col >= layout.colCount) return null;
    const m = merges.find(
      (x) => selection.row >= x.r1 && selection.row <= x.r2 && selection.col >= x.c1 && selection.col <= x.c2,
    );
    if (m !== undefined) return mergeBox(m);
    return { top: top(selection.row), left: left(selection.col), width: width(selection.col), height: height(selection.row) };
  });
</script>

<div
  class="grid"
  style:--row-header={rowHeaderWidth + 'px'}
  style:--col-header={HEADER_HEIGHT + 'px'}
  style:--cell-font={Math.min(24, Math.max(6, defaultPt)) + 'pt'}
>
  <div class="corner" aria-hidden="true"></div>

  <div class="col-header" aria-hidden="true">
    <div class="col-header-inner" style:width={totalWidth + 'px'} style:transform={'translateX(' + -scrollLeft + 'px)'}>
      {#each visibleCols as c (c)}
        <div
          class="ch"
          class:hidden-col={(layout.colHidden[c] ?? 0) !== 0}
          style:left={left(c) + 'px'}
          style:width={width(c) + 'px'}
        >
          {columnLabel(c)}
        </div>
      {/each}
    </div>
  </div>

  <div class="row-header" aria-hidden="true">
    <div class="row-header-inner" style:height={totalHeight + 'px'} style:transform={'translateY(' + -scrollTop + 'px)'}>
      {#each visibleRows as r (r)}
        {@const n = sideRow(r)}
        <div
          class="rh {rowTone(r)}"
          class:changed={(layout.rowState[r] ?? 0) === 1}
          class:hidden-row={rowHiddenSomewhere(layout, r)}
          style:top={top(r) + 'px'}
          style:height={height(r) + 'px'}
          title={rowHiddenSomewhere(layout, r) ? '非表示の行' : undefined}
        >
          {n >= 0 ? n + 1 : ''}
        </div>
      {/each}
    </div>
  </div>

  <div
    class="viewport"
    role="grid"
    tabindex="-1"
    aria-label={side === 'old' ? '旧版のシート' : '新版のシート'}
    bind:this={viewport}
    bind:clientWidth={viewportWidth}
    bind:clientHeight={viewportHeight}
    onscroll={handleScroll}
  >
    <div class="canvas" style:width={totalWidth + 'px'} style:height={totalHeight + 'px'}>
      {#each visibleRows as r (r)}
        {@const tone = rowTone(r)}
        {#if tone !== ''}
          <div class="row-tone {tone}" style:top={top(r) + 'px'} style:height={height(r) + 'px'}></div>
        {/if}
        {#if tone !== 'filler'}
          {#each visibleCols as c (c)}
            {#if !covered.has(r + ':' + c)}
              {@const cell = cellText(r, c)}
              {@const css = cssFor(r, c, cell)}
              <div
                class="cell"
                class:changed={isChanged(r, c)}
                class:filled={css.filled}
                role="gridcell"
                tabindex="-1"
                style={css.text}
                style:top={top(r) + 'px'}
                style:left={left(c) + 'px'}
                style:width={width(c) + 'px'}
                style:height={height(r) + 'px'}
                title={cell !== null && cell.text.length > 0 ? cell.text : undefined}
                onmousedown={() => onselect(r, c)}
              >
                {cell?.text ?? ''}
              </div>
            {/if}
          {/each}
        {/if}
      {/each}

      {#each shownMerges as m (m.r1 + ':' + m.c1)}
        {#if sideRow(m.r1) >= 0}
          {@const box = mergeBox(m)}
          {@const cell = cellText(m.r1, m.c1)}
          {@const css = cssFor(m.r1, m.c1, cell)}
          <div
            class="cell merged"
            class:changed={isChanged(m.r1, m.c1)}
            class:filled={css.filled}
            role="gridcell"
            tabindex="-1"
            style={css.text}
            style:top={box.top + 'px'}
            style:left={box.left + 'px'}
            style:width={box.width + 'px'}
            style:height={box.height + 'px'}
            onmousedown={() => onselect(m.r1, m.c1)}
          >
            {cell?.text ?? ''}
          </div>
        {/if}
      {/each}

      {#if selectionBox !== null}
        <div
          class="selection"
          aria-hidden="true"
          style:top={selectionBox.top + 'px'}
          style:left={selectionBox.left + 'px'}
          style:width={selectionBox.width + 'px'}
          style:height={selectionBox.height + 'px'}
        ></div>
      {/if}
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

  .ch,
  .rh {
    position: absolute;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    white-space: nowrap;
    font-size: 11px;
  }

  .ch {
    top: 0;
    height: 100%;
    border-right: 1px solid var(--app-border-subtle);
  }

  .rh {
    left: 0;
    width: 100%;
    border-bottom: 1px solid var(--app-border-subtle);
  }

  .rh.changed {
    color: var(--app-text-modified);
    font-weight: 700;
  }

  .rh.added {
    color: var(--app-text-added);
    font-weight: 700;
  }

  .rh.removed {
    color: var(--app-text-removed);
    font-weight: 700;
  }

  /* 非表示の行・列は見出しに斜体と下線で印を付ける（隠したままにしないものがあるため） */
  .rh.hidden-row,
  .ch.hidden-col {
    font-style: italic;
    text-decoration: underline dotted;
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

  .row-tone {
    position: absolute;
    left: 0;
    right: 0;
    box-sizing: border-box;
    border-bottom: 1px solid var(--app-excel-grid-line);
  }

  .row-tone.added {
    background: var(--app-excel-added-bg);
  }

  .row-tone.removed {
    background: var(--app-excel-removed-bg);
  }

  /* 片側に無い行。行を揃えるために挟んだ隙間であることを斜線で示す */
  .row-tone.filler {
    background: repeating-linear-gradient(
      -45deg,
      var(--app-excel-filler-bg),
      var(--app-excel-filler-bg) 6px,
      var(--app-excel-filler-stripe) 6px,
      var(--app-excel-filler-stripe) 12px
    );
  }

  /*
   * セルは縦向きの flex の箱にして、縦の配置（Excel の既定は下寄せ）を justify-content で表す。
   * 横の配置・色・罫線などの書式は、検証済みの値だけで組んだ style 属性で上書きする（lib/excelStyle.ts）。
   */
  .cell {
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

  .cell.merged {
    background: var(--app-excel-paper);
    z-index: 1;
  }

  /*
   * 変わったセル。塗りの無いセルは黄色の地、塗りのあるセルは塗りを残して枠だけを重ねる
   * （書式の色を消すと、元の見た目と比べられなくなる）。
   */
  .cell.changed {
    box-shadow: inset 0 0 0 2px var(--app-excel-changed-outline);
  }

  .cell.changed:not(.filled) {
    background: var(--app-excel-changed-bg);
  }

  .selection {
    position: absolute;
    box-sizing: border-box;
    border: 2px solid var(--app-excel-selection);
    pointer-events: none;
    z-index: 2;
  }
</style>
