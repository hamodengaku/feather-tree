<script lang="ts">
  import type { Snippet } from 'svelte';
  import { computeWindow, createTextMeasurer } from '@feathertree/base-ui';
  import type { BranchTreeRow } from '../lib/branchTree.js';

  interface Props {
    rows: readonly BranchTreeRow[];
    /** 1 行分の描画。行の見た目はブランチペイン側が持つ。 */
    row: Snippet<[BranchTreeRow]>;
  }

  const { rows, row }: Props = $props();

  /** --app-metric-row-height と揃える。VirtualFileList と同じ値。 */
  const ROW_HEIGHT = 22;
  /** 三角/●(12px) + gap(5px) + 左右パディング(8+8px) の見込み。フォント差に少し余裕を持たせる。 */
  const ROW_CHROME = 38;
  /** 階層 1 段あたりの字下げ。BranchPane の indent() と揃える。 */
  const INDENT_STEP = 12;
  /** ahead / behind / gone バッジ 1 個分の見込み幅。 */
  const BADGE_WIDTH = 36;

  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  let viewportEl = $state<HTMLDivElement | null>(null);
  let contentWidth = $state(0);

  const view = $derived(computeWindow(rows.length, scrollTop, viewportHeight, { rowHeight: ROW_HEIGHT }));

  /** ラベルの実測幅。展開・折りたたみのたびに測り直すので、同じ文字列は使い回す。 */
  const measurer = createTextMeasurer();

  /**
   * 横スクロール用の幅。仮想化で画面外の行は DOM に無いため、
   * 可視範囲だけで測ると長い名前がスクロール中に見えたり消えたりして幅がちらつく。
   * そのため表示対象の全行から測る。
   */
  $effect(() => {
    if (viewportEl === null) return;
    if (rows.length === 0) {
      contentWidth = 0;
      return;
    }
    const font = getComputedStyle(viewportEl).font;
    let max = 0;
    for (const r of rows) {
      let w = r.depth * INDENT_STEP + ROW_CHROME + measurer.width(r.label, font);
      // フォルダ行も同名ブランチを兼ねることがあるので union のまま読む
      const branch = r.branch;
      if (branch !== null) {
        if (branch.ahead > 0) w += BADGE_WIDTH;
        if (branch.behind > 0) w += BADGE_WIDTH;
        if (branch.gone) w += BADGE_WIDTH;
      }
      if (w > max) max = w;
    }
    contentWidth = Math.ceil(max);
  });

  const visible = $derived(
    Array.from({ length: Math.max(0, view.endIndex - view.startIndex) }, (_, i) => ({
      index: view.startIndex + i,
      row: rows[view.startIndex + i],
    })),
  );

  function handleScroll(event: Event): void {
    const target = event.currentTarget as HTMLElement;
    scrollTop = target.scrollTop;
    viewportHeight = target.clientHeight;
  }
</script>

<div
  class="viewport"
  onscroll={handleScroll}
  bind:clientHeight={viewportHeight}
  bind:this={viewportEl}
>
  <div class="spacer" style:height={view.totalHeight + 'px'} style:width={contentWidth + 'px'}>
    <ul class="rows" style:transform={'translateY(' + view.paddingTop + 'px)'}>
      {#each visible as item (item.index)}
        {#if item.row !== undefined}
          {@render row(item.row)}
        {/if}
      {/each}
    </ul>
  </div>
</div>

<style>
  .viewport {
    flex: 1 1 auto;
    /* 縦だけでなく横にもスクロールさせる（ブランチ名を省略記号で切らない）。 */
    overflow: auto;
    min-height: 0;
    min-width: 0;
  }

  .spacer {
    position: relative;
    min-width: 100%;
  }

  .rows {
    position: absolute;
    inset: 0 0 auto 0;
    margin: 0;
    padding: 0;
    list-style: none;
    will-change: transform;
  }
</style>
