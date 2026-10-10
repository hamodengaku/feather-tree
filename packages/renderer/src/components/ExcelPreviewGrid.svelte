<script lang="ts">
  /*
   * マージ後のプレビュー（docs/07-xlsx-cell-merge.md 7.3）。左右のグリッドの下に出す、読むだけのグリッド。
   *
   * 行の並びは @feathertree/conflict-plan の planSheet（書き込みと同じもの）。セルの値・書式は左右のグリッドが
   * 読んだ行（揃えた行のページ）から、その行・セルで採った側を引く。行番号は書き込み後のもの。
   *
   * 列の幅は上と同じ累積和を使い、横のスクロールは親が上と同期させる。縦は行の並びが違うので同期しない
   * （上でセルを選ぶと、親が focusRow でこちらを対応する行へ動かす）。行の高さは上と同じ（非表示の行は高さ 0 で
   * 描かない）。結合セルは描かない。枠は ExcelGridFrame、入力欄は CellEditor（上のグリッドと共有）。
   */
  import type { PlanRow } from '@feathertree/conflict-plan';
  import type { ExcelRowDto, ExcelRowSideDto, ExcelSheetLayoutDto } from '@feathertree/ipc';
  import { untrack } from 'svelte';
  import { buildOffsets, indexAtOffset, rangeAtOffset } from '@feathertree/base-ui';
  import CellEditor from './CellEditor.svelte';
  import ExcelGridFrame from './ExcelGridFrame.svelte';
  import { cellIndex, columnLabel, rectOf } from '../lib/excelGrid.js';
  import { cellCss, styleIndexFor, type CellCss } from '../lib/excelStyle.js';

  interface Props {
    layout: ExcelSheetLayoutDto;
    previewRows: readonly PlanRow[];
    rows: ReadonlyMap<number, ExcelRowDto>;
    /** 揃えた行ごとの高さ（上のグリッドと同じ。非表示の行は 0）。 */
    rowHeights: Float64Array;
    colOffsets: Float64Array;
    rowHeaderWidth: number;
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
    previewRows,
    rows,
    rowHeights,
    colOffsets,
    rowHeaderWidth,
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

  let canvas = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let scrollLeft = $state(0);
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);

  const rowOffsets = $derived(buildOffsets(previewRows.map((r) => rowHeights[r.aligned] ?? 20)));
  const totalHeight = $derived(rowOffsets[rowOffsets.length - 1] ?? 0);
  const totalWidth = $derived(colOffsets[colOffsets.length - 1] ?? 0);
  const rowRange = $derived(rangeAtOffset(rowOffsets, scrollTop, viewportHeight, 3));
  const colRange = $derived(rangeAtOffset(colOffsets, scrollLeft, viewportWidth, 2));

  /** 見えている行・列（高さ・幅 0 の非表示は除く）。 */
  const visibleRows = $derived.by(() => {
    const out: number[] = [];
    for (let k = rowRange.start; k < rowRange.end; k += 1) {
      if ((rowOffsets[k + 1] ?? 0) > (rowOffsets[k] ?? 0)) out.push(k);
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

  interface PreviewCell {
    readonly text: string;
    readonly kind: number;
    readonly style: number;
    readonly side: 'old' | 'new';
    /** '' / theirs（相手側から採った）/ edited / undecided */
    readonly mark: string;
  }

  const sideName = (pr: PlanRow): 'old' | 'new' => (pr.side === 'ours' ? 'old' : 'new');

  function fromSide(side: ExcelRowSideDto | null | undefined, which: 'old' | 'new', c: number, mark: string): PreviewCell | null {
    const i = cellIndex(side, c);
    if (side == null || i < 0) return mark === '' ? null : { text: '', kind: 0, style: 0, side: which, mark };
    return { text: side.text[i] ?? '', kind: side.kind[i] ?? 0, style: side.style[i] ?? 0, side: which, mark };
  }

  function cellOf(pr: PlanRow, c: number): PreviewCell | null {
    const row = rows.get(pr.aligned);
    if (row === undefined) return null;
    const which = sideName(pr);
    const own = which === 'old' ? row.old : row.new;
    // 打った値（値の違わないセルも含む）。受け取る版にだけ載っている
    const typed = pr.edits.get(c);
    if (typed !== undefined) {
      const base = fromSide(own, which, c, 'edited');
      return { text: typed, kind: 2, style: base?.style ?? 0, side: which, mark: 'edited' };
    }
    switch (pr.kind) {
      case 'undecided':
        return fromSide(own, which, c, 'undecided');
      case 'cells':
        if (pr.theirsCols.has(c)) return fromSide(row.new, 'new', c, 'theirs');
        return fromSide(row.old, 'old', c, pr.undecidedCols.has(c) ? 'undecided' : '');
      default:
        // 両方を採用で足した相手側の版には印を付ける（相手側にしか無い行は、行そのものが相手側から）
        return fromSide(own, which, c, pr.side === 'theirs' && row.old !== null ? 'theirs' : '');
    }
  }

  function cssFor(pr: PlanRow, c: number, cell: PreviewCell | null): CellCss {
    const old = (cell?.side ?? sideName(pr)) === 'old';
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
  function hit(e: MouseEvent): { k: number; c: number; pr: PlanRow } | null {
    if (canvas === null || previewRows.length === 0) return null;
    const rect = canvas.getBoundingClientRect();
    const k = Math.min(previewRows.length - 1, indexAtOffset(rowOffsets, e.clientY - rect.top));
    const c = Math.min(Math.max(0, layout.colCount - 1), indexAtOffset(colOffsets, e.clientX - rect.left));
    const pr = previewRows[k];
    return pr === undefined ? null : { k, c, pr };
  }

  function pick(e: MouseEvent): void {
    if (e.button !== 0) return;
    const at = hit(e);
    if (at !== null) onselect(at.pr.aligned, at.c);
  }

  function dbl(e: MouseEvent): void {
    const at = hit(e);
    if (at === null || ondblcell === undefined || !at.pr.receivesEdits) return;
    const cell = cellOf(at.pr, at.c);
    ondblcell(at.k, at.pr.aligned, at.c, cell?.side ?? sideName(at.pr));
  }
</script>

<ExcelGridFrame
  {rowHeaderWidth}
  fontPt={layout.oldDefaultFontPt}
  {totalWidth}
  {totalHeight}
  label="マージ後のプレビュー"
  bind:viewport
  bind:canvas
  bind:scrollTop
  bind:scrollLeft
  bind:viewportWidth
  bind:viewportHeight
  onscroll={(_top, left) => onscroll(left)}
  onmousedown={pick}
  ondblclick={dbl}
>
  {#snippet colHeaders()}
    {#each visibleCols as c (c)}
      <div class="ch" style:left={left(c) + 'px'} style:width={width(c) + 'px'}>{columnLabel(c)}</div>
    {/each}
  {/snippet}

  {#snippet rowHeaders()}
    {#each visibleRows as k (k)}
      {@const pr = previewRows[k]}
      <div
        class="rh"
        class:undecided={pr?.kind === 'undecided'}
        class:selected={pr !== undefined && pr.aligned === selectedAligned}
        style:top={top(k) + 'px'}
        style:height={height(k) + 'px'}
      >
        {k + 1}
      </div>
    {/each}
  {/snippet}

  {#each visibleRows as k (k)}
    {@const pr = previewRows[k]}
    {#if pr !== undefined}
      {#if pr.kind === 'undecided'}
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
    <CellEditor
      value={editing.value}
      box={rectOf(rowOffsets, colOffsets, { r1: editing.index, c1: editing.col, r2: editing.index, c2: editing.col })}
      oncommit={oneditcommit}
      oncancel={oneditcancel}
    />
  {/if}
</ExcelGridFrame>

<style>
  .rh.undecided {
    color: var(--app-text-conflict);
    font-weight: 700;
  }

  .rh.selected {
    background: color-mix(in srgb, var(--app-excel-selection) 22%, transparent);
  }

  .row-tone.undecided {
    box-shadow: inset 4px 0 0 var(--app-text-conflict);
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

  .cell.selected-row {
    background-image: linear-gradient(
      color-mix(in srgb, var(--app-excel-selection) 10%, transparent),
      color-mix(in srgb, var(--app-excel-selection) 10%, transparent)
    );
  }
</style>
