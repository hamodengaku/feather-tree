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
   * 枠（見出し・本体・スクロール）は ExcelGridFrame、入力欄は CellEditor（マージ後のプレビューと共有）。
   * 文字はすべてテキスト補間で出す（{@html} は使わない。ファイルの中身は信頼できない入力）。
   */
  import type { ExcelRowDto, ExcelRowSideDto, ExcelSheetLayoutDto } from '@feathertree/ipc';
  import { untrack } from 'svelte';
  import { indexAtOffset, rangeAtOffset } from '@feathertree/base-ui';
  import CellEditor from './CellEditor.svelte';
  import ExcelGridFrame from './ExcelGridFrame.svelte';
  import {
    ROW_ADDED,
    ROW_REMOVED,
    cellIndex,
    columnLabel,
    coveredCells,
    mergeRects,
    rectOf,
    rowHiddenSomewhere,
    visibleMerges,
    type Box,
  } from '../lib/excelGrid.js';
  import type { CellRange } from '../lib/excelConflict.js';
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
    /** 左ボタンを押した（セル・行番号・列番号）。Shift / Ctrl は範囲の広げ方（docs/07 7.1）。 */
    onpointer: (kind: 'cell' | 'row' | 'col', row: number, col: number, mods: { shift: boolean; ctrl: boolean }) => void;
    /** 押したまま入った（ドラッグで範囲を伸ばす）。 */
    onpointerenter: (kind: 'cell' | 'row' | 'col', row: number, col: number) => void;
    /** 右クリック。画面の座標を添える（メニューを出す位置）。 */
    oncontext?: ((row: number, col: number, x: number, y: number) => void) | undefined;
    /** ダブルクリック（セルの編集を始める）。 */
    ondblcell?: (row: number, col: number) => void;
    /** 選んでいる範囲（左右で共有）。 */
    ranges?: readonly CellRange[];
    /** このグリッドで編集中のセル。 */
    editing?: { readonly row: number; readonly col: number; readonly value: string } | null;
    oneditcommit?: (value: string) => void;
    oneditcancel?: () => void;
    /**
     * 未マージでセル単位に採れるとき（決定 34）: 揃えた座標の採り方（自分側・相手側・未決定）。
     * 採った側のセルに印を付け、採らなかった側を薄くする。null なら印を出さない。
     */
    choiceOf?: ((row: number, col: number) => 'ours' | 'theirs' | 'edit' | 'ours-theirs' | 'theirs-ours' | null) | null;
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
    onpointer,
    onpointerenter,
    oncontext,
    ondblcell,
    ranges = [],
    editing = null,
    oneditcommit,
    oneditcancel,
    choiceOf = null,
  }: Props = $props();

  function mods(e: MouseEvent): { shift: boolean; ctrl: boolean } {
    return { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
  }

  /** 左ボタンで押した。文字の選択（ブラウザの既定）を止め、キーボードの打鍵を受けられるよう本体に焦点を置く。 */
  function down(e: MouseEvent, kind: 'cell' | 'row' | 'col', row: number, col: number): void {
    if (e.button !== 0) return;
    e.preventDefault();
    viewport?.focus();
    onpointer(kind, row, col, mods(e));
  }

  function context(e: MouseEvent, row: number, col: number): void {
    if (oncontext === undefined) return;
    e.preventDefault();
    oncontext(row, col, e.clientX, e.clientY);
  }

  let canvas = $state<HTMLDivElement | null>(null);
  let lastHover = { row: -1, col: -1 };

  /** マウスの位置の揃えた行・列。結合セルの中なら左上のセル。 */
  function hit(e: MouseEvent): { row: number; col: number } | null {
    if (canvas === null || layout.rowCount === 0) return null;
    const rect = canvas.getBoundingClientRect();
    const row = Math.min(layout.rowCount - 1, indexAtOffset(rowOffsets, e.clientY - rect.top));
    const col = Math.min(Math.max(0, layout.colCount - 1), indexAtOffset(colOffsets, e.clientX - rect.left));
    const m = merges.find((x) => row >= x.r1 && row <= x.r2 && col >= x.c1 && col <= x.c2);
    return m !== undefined ? { row: m.r1, col: m.c1 } : { row, col };
  }

  /** 行番号・列番号を、範囲に掛かっていれば強調する。 */
  function rowSelected(r: number): boolean {
    return ranges.some((x) => r >= x.r1 && r <= x.r2);
  }
  function colSelected(c: number): boolean {
    return ranges.some((x) => c >= x.c1 && c <= x.c2);
  }

  /** 範囲の箱（揃えた座標 → 画素）。シートの外は切り詰める。 */
  function rangeBox(r: CellRange): Box {
    return rectOf(rowOffsets, colOffsets, {
      r1: r.r1,
      c1: r.c1,
      r2: Math.min(r.r2, layout.rowCount - 1),
      c2: Math.min(r.c2, Math.max(0, layout.colCount - 1)),
    });
  }

  /** このグリッドが表す側（未マージでは old = 自分側、new = 相手側）。 */
  const mySide = $derived(side === 'old' ? 'ours' : 'theirs');

  /** 採り方の印。picked = この側を採る、rejected = もう一方を採る。違いの無い所には付けない。 */
  function pickClass(r: number, c: number, changed: boolean): string {
    if (choiceOf === null || !changed) return '';
    const pick = choiceOf(r, c);
    if (pick === null) return 'undecided';
    if (pick === 'edit') return 'edited';
    // 両方を採用（docs/07 7.2）: 両側とも残る
    if (pick === 'ours-theirs' || pick === 'theirs-ours') return 'both';
    return pick === mySide ? 'picked' : 'rejected';
  }

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

  const selectionBox = $derived.by(() => {
    if (selection === null || selection.row >= layout.rowCount || selection.col >= layout.colCount) return null;
    const m = merges.find(
      (x) => selection.row >= x.r1 && selection.row <= x.r2 && selection.col >= x.c1 && selection.col <= x.c2,
    );
    return rectOf(rowOffsets, colOffsets, m ?? { r1: selection.row, c1: selection.col, r2: selection.row, c2: selection.col });
  });
</script>

<ExcelGridFrame
  {rowHeaderWidth}
  fontPt={defaultPt}
  {totalWidth}
  {totalHeight}
  label={side === 'old' ? '旧版のシート' : '新版のシート'}
  bind:viewport
  bind:canvas
  bind:scrollTop
  bind:scrollLeft
  bind:viewportWidth
  bind:viewportHeight
  {onscroll}
  onmousedown={(e) => {
    const at = hit(e);
    if (at !== null) down(e, 'cell', at.row, at.col);
  }}
  onmousemove={(e) => {
    if ((e.buttons & 1) === 0) return;
    const at = hit(e);
    if (at !== null && (at.row !== lastHover.row || at.col !== lastHover.col)) {
      lastHover = at;
      onpointerenter('cell', at.row, at.col);
    }
  }}
  oncontextmenu={(e) => {
    const at = hit(e);
    if (at !== null) context(e, at.row, at.col);
  }}
  ondblclick={(e) => {
    const at = hit(e);
    if (at !== null) ondblcell?.(at.row, at.col);
  }}
>
  {#snippet colHeaders()}
    {#each visibleCols as c (c)}
      <div
        class="ch"
        role="columnheader"
        tabindex="-1"
        class:hidden-col={(layout.colHidden[c] ?? 0) !== 0}
        class:in-range={colSelected(c)}
        style:left={left(c) + 'px'}
        style:width={width(c) + 'px'}
        onmousedown={(e) => down(e, 'col', 0, c)}
        onmouseenter={() => onpointerenter('col', 0, c)}
      >
        {columnLabel(c)}
      </div>
    {/each}
  {/snippet}

  {#snippet rowHeaders()}
    {#each visibleRows as r (r)}
      {@const n = sideRow(r)}
      <div
        class="rh {rowTone(r)}"
        role="rowheader"
        tabindex="-1"
        class:changed={(layout.rowState[r] ?? 0) === 1}
        class:hidden-row={rowHiddenSomewhere(layout, r)}
        class:in-range={rowSelected(r)}
        style:top={top(r) + 'px'}
        style:height={height(r) + 'px'}
        title={rowHiddenSomewhere(layout, r) ? '非表示の行' : undefined}
        onmousedown={(e) => down(e, 'row', r, 0)}
        onmouseenter={() => onpointerenter('row', r, 0)}
      >
        {n >= 0 ? n + 1 : ''}
      </div>
    {/each}
  {/snippet}

  {#each visibleRows as r (r)}
    {@const tone = rowTone(r)}
    {#if tone !== ''}
      <div class="row-tone {tone} {pickClass(r, 0, true)}" style:top={top(r) + 'px'} style:height={height(r) + 'px'}></div>
    {/if}
    {#if tone !== 'filler'}
      {#each visibleCols as c (c)}
        {#if !covered.has(r + ':' + c)}
          {@const cell = cellText(r, c)}
          {@const css = cssFor(r, c, cell)}
          <div
            class="cell {pickClass(r, c, isChanged(r, c))}"
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
          >
            {cell?.text ?? ''}
          </div>
        {/if}
      {/each}
    {/if}
  {/each}

  {#each shownMerges as m (m.r1 + ':' + m.c1)}
    {#if sideRow(m.r1) >= 0}
      {@const box = rectOf(rowOffsets, colOffsets, m)}
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
      >
        {cell?.text ?? ''}
      </div>
    {/if}
  {/each}

  {#each ranges as range, i (i)}
    {@const box = rangeBox(range)}
    <div
      class="range"
      aria-hidden="true"
      style:top={box.top + 'px'}
      style:left={box.left + 'px'}
      style:width={box.width + 'px'}
      style:height={box.height + 'px'}
    ></div>
  {/each}

  {#if editing !== null && editing.row < layout.rowCount}
    <CellEditor
      value={editing.value}
      box={rangeBox({ r1: editing.row, c1: editing.col, r2: editing.row, c2: editing.col })}
      oncommit={oneditcommit}
      oncancel={oneditcancel}
    />
  {/if}

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
</ExcelGridFrame>

<style>
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

  .row-tone {
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

  /* 採り方の印（決定 34）。採る側は太い枠、採らない側は薄く消し線、未決定は点線の枠 */
  .cell.picked {
    box-shadow: inset 0 0 0 3px var(--app-text-added);
  }

  .cell.rejected {
    opacity: 0.45;
    text-decoration: line-through;
  }

  .cell.undecided {
    outline: 2px dashed var(--app-text-conflict);
    outline-offset: -2px;
  }

  .row-tone.picked {
    box-shadow: inset 4px 0 0 var(--app-text-added);
  }

  .row-tone.rejected {
    opacity: 0.45;
  }

  .row-tone.undecided {
    box-shadow: inset 4px 0 0 var(--app-text-conflict);
  }

  /* 選んでいる範囲（Excel と同じく薄い塗り）。行番号・列番号も強調する */
  .range {
    position: absolute;
    box-sizing: border-box;
    background: color-mix(in srgb, var(--app-excel-selection) 14%, transparent);
    border: 1px solid var(--app-excel-selection);
    pointer-events: none;
    z-index: 2;
  }

  .ch.in-range,
  .rh.in-range {
    background: color-mix(in srgb, var(--app-excel-selection) 22%, transparent);
  }

  .ch,
  .rh {
    cursor: default;
  }

  /* 両方を採用した所（docs/07 7.2）。両側とも残るので、両側に同じ印 */
  .cell.both {
    box-shadow: inset 0 0 0 3px var(--app-text-added);
    outline: 1px dashed var(--app-accent);
    outline-offset: -5px;
  }

  .row-tone.both {
    box-shadow: inset 4px 0 0 var(--app-accent);
  }

  /* 打った値で決めたセル（docs/07 7.1） */
  .cell.edited {
    box-shadow: inset 0 0 0 3px var(--app-accent);
  }

  .selection {
    position: absolute;
    box-sizing: border-box;
    border: 2px solid var(--app-excel-selection);
    pointer-events: none;
    z-index: 2;
  }
</style>
