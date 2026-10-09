<script lang="ts">
  /*
   * マージ後のプレビュー（docs/07-xlsx-cell-merge.md 7.3）。左右のグリッドの下に出す、読むだけのグリッド。
   *
   * 行の並びは lib/excelPreview.ts が今の採り方から作る（書き込みと同じ規則）。セルの値・書式は左右のグリッドが
   * 読んだ行（揃えた行のページ）から、その行・セルで採った側を引く。行番号は書き込み後のもの。
   *
   * 列の幅は上と同じ累積和を使い、横のスクロールは親が上と同期させる。縦は行の並びが違うので同期しない
   * （上でセルを選ぶと、親が focusRow でこちらを対応する行へ動かす）。結合セルは描かない。
   */
  import type { ExcelRowDto, ExcelRowSideDto, ExcelSheetLayoutDto, ExcelSheetSummaryDto } from '@feathertree/ipc';
  import { untrack } from 'svelte';
  import { buildOffsets, rangeAtOffset } from '@feathertree/base-ui';
  import { HEADER_HEIGHT, cellIndex, columnLabel } from '../lib/excelGrid.js';
  import { choiceForCell, type ConflictChoiceState } from '../lib/excelConflict.js';
  import type { PreviewRow } from '../lib/excelPreview.js';
  import { cellCss, styleIndexFor, type CellCss } from '../lib/excelStyle.js';

  interface Props {
    layout: ExcelSheetLayoutDto;
    summary: ExcelSheetSummaryDto | undefined;
    sheet: number;
    previewRows: readonly PreviewRow[];
    rows: ReadonlyMap<number, ExcelRowDto>;
    colOffsets: Float64Array;
    rowHeaderWidth: number;
    choices: ConflictChoiceState;
    editOf: (row: number, col: number) => string | undefined;
    /** 選んでいる揃えた行（強調する）。 */
    selectedAligned: number | null;
    /** この位置（プレビューの添字）が見えるように動かす。seq が変わるたびに 1 回だけ効く。 */
    focusRow: { readonly index: number; readonly seq: number } | null;
    viewport?: HTMLDivElement | null;
    onscroll: (left: number) => void;
    /** 揃えた行 [start, end) の中身が要る（上のグリッドと同じページの取り方）。 */
    onneed: (start: number, end: number) => void;
    onselect: (aligned: number, col: number) => void;
    /** ダブルクリックで編集を始める（打った値を受け取る版のセルだけ）。side はそのセルに出ている側。 */
    ondblcell?: (index: number, aligned: number, col: number, side: 'old' | 'new') => void;
    /** プレビューで編集中のセル。 */
    editing?: { readonly index: number; readonly col: number; readonly value: string } | null;
    oneditcommit?: (value: string) => void;
    oneditcancel?: () => void;
  }

  let {
    layout,
    summary,
    sheet,
    previewRows,
    rows,
    colOffsets,
    rowHeaderWidth,
    choices,
    editOf,
    selectedAligned,
    focusRow,
    viewport = $bindable(null),
    onscroll,
    onneed,
    onselect,
    ondblcell,
    editing = null,
    oneditcommit,
    oneditcancel,
  }: Props = $props();

  /** 打った値を受け取る版か（自分側の版。自分側に行が無ければ相手側の版）。docs/07 7.3。 */
  function receivesEdits(pr: PreviewRow): boolean {
    return pr.side === 'ours' || (layout.oldRow[pr.aligned] ?? -1) < 0;
  }

  function focusEditor(el: HTMLInputElement): void {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  function editorKey(e: KeyboardEvent): void {
    const target = e.currentTarget as HTMLInputElement;
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      oneditcommit?.(target.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      oneditcancel?.();
    }
  }

  let scrollTop = $state(0);
  let scrollLeft = $state(0);
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);

  const rowOffsets = $derived(buildOffsets(previewRows.map((r) => layout.rowHeight[r.aligned] ?? 20)));
  const totalHeight = $derived(rowOffsets[rowOffsets.length - 1] ?? 0);
  const totalWidth = $derived(colOffsets[colOffsets.length - 1] ?? 0);
  const rowRange = $derived(rangeAtOffset(rowOffsets, scrollTop, viewportHeight, 3));
  const colRange = $derived(rangeAtOffset(colOffsets, scrollLeft, viewportWidth, 2));

  const visibleRows = $derived.by(() => {
    const out: number[] = [];
    for (let k = rowRange.start; k < rowRange.end; k += 1) out.push(k);
    return out;
  });
  const visibleCols = $derived.by(() => {
    const out: number[] = [];
    for (let c = colRange.start; c < colRange.end; c += 1) {
      if ((colOffsets[c + 1] ?? 0) > (colOffsets[c] ?? 0)) out.push(c);
    }
    return out;
  });

  // 見えている行の中身を取りに行く（揃えた行の範囲で頼む）
  $effect(() => {
    const k1 = rowRange.start;
    const k2 = rowRange.end;
    untrack(() => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = k1; k < k2; k += 1) {
        const a = previewRows[k]?.aligned;
        if (a === undefined) continue;
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
      }
      if (lo <= hi) onneed(lo, hi + 1);
    });
  });

  // 上のグリッドで選んだ行へ移る（見えていなければ上から 1/3 の位置へ）
  let handledFocus = 0;
  $effect(() => {
    const f = focusRow;
    const el = viewport;
    if (f === null || el === null || f.seq === handledFocus) return;
    handledFocus = f.seq;
    untrack(() => {
      const top = rowOffsets[f.index] ?? 0;
      const bottom = rowOffsets[f.index + 1] ?? top;
      if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    });
  });

  function handleScroll(event: Event): void {
    const target = event.currentTarget as HTMLDivElement;
    scrollTop = target.scrollTop;
    scrollLeft = target.scrollLeft;
    onscroll(scrollLeft);
  }

  interface PreviewCell {
    readonly text: string;
    readonly kind: number;
    readonly style: number;
    readonly side: 'old' | 'new';
    /** '' / theirs（相手側から採った）/ edited / undecided / both（両方を採用で足した相手側の行） */
    readonly mark: string;
  }

  function fromSide(side: ExcelRowSideDto | null | undefined, which: 'old' | 'new', c: number, mark: string): PreviewCell | null {
    const i = cellIndex(side, c);
    if (side == null || i < 0) return mark === '' ? null : { text: '', kind: 0, style: 0, side: which, mark };
    return { text: side.text[i] ?? '', kind: side.kind[i] ?? 0, style: side.style[i] ?? 0, side: which, mark };
  }

  function cellOf(pr: PreviewRow, c: number): PreviewCell | null {
    const row = rows.get(pr.aligned);
    if (row === undefined) return null;
    // 打った値（値の違わないセルも含む）。受け取る版にだけ出す
    const typed = receivesEdits(pr) ? editOf(pr.aligned, c) : undefined;
    if (typed !== undefined) {
      const which = pr.side === 'ours' ? 'old' : 'new';
      const base = fromSide(which === 'old' ? row.old : row.new, which, c, 'edited');
      return { text: typed, kind: 2, style: base?.style ?? 0, side: which, mark: 'edited' };
    }
    if (pr.undecided) return fromSide(pr.side === 'ours' ? row.old : row.new, pr.side === 'ours' ? 'old' : 'new', c, 'undecided');
    if (!pr.mixed) return fromSide(pr.side === 'ours' ? row.old : row.new, pr.side === 'ours' ? 'old' : 'new', c, pr.side === 'theirs' && row.old !== null ? 'theirs' : '');
    if (!row.changedCols.includes(c)) return fromSide(row.old, 'old', c, '');
    const choice = choiceForCell(choices, sheet, pr.aligned, c, summary);
    if (choice === 'edit') {
      const base = fromSide(row.old, 'old', c, 'edited');
      return { text: editOf(pr.aligned, c) ?? '', kind: 2, style: base?.style ?? 0, side: 'old', mark: 'edited' };
    }
    if (choice === 'theirs') return fromSide(row.new, 'new', c, 'theirs');
    if (choice === null) return fromSide(row.old, 'old', c, 'undecided');
    return fromSide(row.old, 'old', c, '');
  }

  function cssFor(pr: PreviewRow, c: number, cell: PreviewCell | null): CellCss {
    const old = (cell?.side ?? (pr.side === 'ours' ? 'old' : 'new')) === 'old';
    const rowStyle = (old ? layout.oldRowStyle : layout.newRowStyle)[pr.aligned] ?? -1;
    const colStyle = (old ? layout.oldColStyle : layout.newColStyle)[c] ?? -1;
    const styles = old ? layout.oldStyles : layout.newStyles;
    const defaultPt = old ? layout.oldDefaultFontPt : layout.newDefaultFontPt;
    return cellCss(styles[styleIndexFor(cell?.style, rowStyle, colStyle)], cell?.kind ?? 0, defaultPt);
  }

  function top(k: number): number {
    return rowOffsets[k] ?? 0;
  }
  function height(k: number): number {
    return (rowOffsets[k + 1] ?? 0) - (rowOffsets[k] ?? 0);
  }
  function left(c: number): number {
    return colOffsets[c] ?? 0;
  }
  function width(c: number): number {
    return (colOffsets[c + 1] ?? 0) - (colOffsets[c] ?? 0);
  }

  /** 押した位置のプレビューの行・列。 */
  let canvas = $state<HTMLDivElement | null>(null);
  function indexAt(offsets: Float64Array, pos: number): number {
    let lo = 0;
    let hi = offsets.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((offsets[mid] ?? 0) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }
  function hit(e: MouseEvent): { k: number; c: number; pr: PreviewRow } | null {
    if (canvas === null || previewRows.length === 0) return null;
    const rect = canvas.getBoundingClientRect();
    const k = Math.min(previewRows.length - 1, indexAt(rowOffsets, e.clientY - rect.top));
    const c = Math.min(Math.max(0, layout.colCount - 1), indexAt(colOffsets, e.clientX - rect.left));
    const pr = previewRows[k];
    return pr === undefined ? null : { k, c, pr };
  }

  function pick(e: MouseEvent): void {
    const at = hit(e);
    if (at !== null) onselect(at.pr.aligned, at.c);
  }

  function dbl(e: MouseEvent): void {
    const at = hit(e);
    if (at === null || ondblcell === undefined || !receivesEdits(at.pr)) return;
    const cell = cellOf(at.pr, at.c);
    ondblcell(at.k, at.pr.aligned, at.c, cell?.side ?? (at.pr.side === 'ours' ? 'old' : 'new'));
  }
</script>

<div class="grid" style:--row-header={rowHeaderWidth + 'px'} style:--col-header={HEADER_HEIGHT + 'px'}>
  <div class="corner" aria-hidden="true"></div>

  <div class="col-header" aria-hidden="true">
    <div class="col-header-inner" style:width={totalWidth + 'px'} style:transform={'translateX(' + -scrollLeft + 'px)'}>
      {#each visibleCols as c (c)}
        <div class="ch" style:left={left(c) + 'px'} style:width={width(c) + 'px'}>{columnLabel(c)}</div>
      {/each}
    </div>
  </div>

  <div class="row-header" aria-hidden="true">
    <div class="row-header-inner" style:height={totalHeight + 'px'} style:transform={'translateY(' + -scrollTop + 'px)'}>
      {#each visibleRows as k (k)}
        {@const pr = previewRows[k]}
        <div
          class="rh"
          class:undecided={pr?.undecided === true}
          class:selected={pr !== undefined && pr.aligned === selectedAligned}
          style:top={top(k) + 'px'}
          style:height={height(k) + 'px'}
        >
          {k + 1}
        </div>
      {/each}
    </div>
  </div>

  <div
    class="viewport"
    role="grid"
    tabindex="-1"
    aria-label="マージ後のプレビュー"
    bind:this={viewport}
    bind:clientWidth={viewportWidth}
    bind:clientHeight={viewportHeight}
    onscroll={handleScroll}
  >
    <div
      class="canvas"
      role="presentation"
      style:width={totalWidth + 'px'}
      style:height={totalHeight + 'px'}
      bind:this={canvas}
      onmousedown={(e) => {
        if (e.button === 0) pick(e);
      }}
      ondblclick={dbl}
    >
      {#each visibleRows as k (k)}
        {@const pr = previewRows[k]}
        {#if pr !== undefined}
          {#if pr.undecided}
            <div class="row-tone undecided" style:top={top(k) + 'px'} style:height={height(k) + 'px'}></div>
          {/if}
          {#each visibleCols as c (c)}
            {@const cell = cellOf(pr, c)}
            {@const css = cssFor(pr, c, cell)}
            <div
              class="cell {cell?.mark ?? ''}"
              class:filled={css.filled}
              class:selected-row={pr.aligned === selectedAligned}
              role="gridcell"
              tabindex="-1"
              style={css.text}
              style:top={top(k) + 'px'}
              style:left={left(c) + 'px'}
              style:width={width(c) + 'px'}
              style:height={height(k) + 'px'}
              title={cell !== null && cell.text.length > 0 ? cell.text : undefined}
            >
              {cell?.text ?? ''}
            </div>
          {/each}
        {/if}
      {/each}

      {#if editing !== null && editing.index < previewRows.length}
        <input
          class="editor"
          aria-label="セルの値（Enter で決定・Esc で取り消し）"
          value={editing.value}
          style:top={top(editing.index) + 'px'}
          style:left={left(editing.col) + 'px'}
          style:min-width={width(editing.col) + 'px'}
          style:height={height(editing.index) + 'px'}
          use:focusEditor
          onkeydown={editorKey}
          onmousedown={(e) => e.stopPropagation()}
          ondblclick={(e) => e.stopPropagation()}
          onblur={(e) => oneditcommit?.((e.currentTarget as HTMLInputElement).value)}
        />
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

  .rh.undecided {
    color: var(--app-text-conflict);
    font-weight: 700;
  }

  .rh.selected {
    background: color-mix(in srgb, var(--app-excel-selection) 22%, transparent);
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
  }

  .row-tone.undecided {
    box-shadow: inset 4px 0 0 var(--app-text-conflict);
  }

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
    line-height: 1.25;
    cursor: cell;
    user-select: none;
  }

  /* 相手側から採ったセル・行（自分側から採った所は印なし） */
  .cell.theirs {
    box-shadow: inset 0 0 0 2px var(--app-text-added);
  }

  .cell.edited {
    box-shadow: inset 0 0 0 3px var(--app-accent);
  }

  .cell.undecided {
    outline: 2px dashed var(--app-text-conflict);
    outline-offset: -2px;
  }

  .editor {
    position: absolute;
    box-sizing: border-box;
    z-index: 4;
    padding: 0 3px;
    border: 2px solid var(--app-accent);
    background: var(--app-excel-paper);
    color: var(--app-excel-ink);
    font: inherit;
    outline: none;
  }

  .cell.selected-row {
    background-image: linear-gradient(color-mix(in srgb, var(--app-excel-selection) 10%, transparent), color-mix(in srgb, var(--app-excel-selection) 10%, transparent));
  }
</style>
