<script lang="ts">
  /*
   * コミットリストの仮想化（docs/01-architecture.md 8 章）。
   *
   * VirtualFileList と同じ作りだが、**総件数が分からない**点が違う。
   * status は main が全件を持っているので filteredTotal を返せるが、履歴は
   * 「1 ページ取ってみるまで次があるか分からない」。そこで末尾に番兵行を 1 つ足し、
   * それが可視範囲に入ったら次のページを要求する。
   */
  import type { BranchDto, CommitSummaryDto } from '@feathertree/ipc';
  import { computeWindow } from '@feathertree/base-ui';
  import { groupRefsByOid, layoutGraph, NO_REFS } from '../lib/commitGraph.js';
  import CommitRow from './CommitRow.svelte';

  interface Props {
    commits: readonly CommitSummaryDto[];
    branches: readonly BranchDto[];
    selectedOid: string | null;
    /** これ以上ページが無い（番兵行を出さない）。 */
    complete: boolean;
    loading: boolean;
    onselect: (oid: string) => void;
    onneedmore: () => void;
  }

  const { commits, branches, selectedOid, complete, loading, onselect, onneedmore }: Props = $props();

  const ROW_HEIGHT = 22;
  /** グラフの幅が際限なく広がらないよう上限を置く。これ以上は重なって見えるだけ。 */
  const MAX_LANES = 12;

  let scrollTop = $state(0);
  let viewportHeight = $state(0);

  /**
   * レーン割り当て。取得済みのコミット配列が変わったときだけ計算し直す（純関数）。
   * 仮想化しても可視範囲だけでは計算できない（レーンは先頭からの積み上げで決まる）ので、
   * ここは常に全件ぶん回す。
   */
  const rows = $derived(layoutGraph(commits));

  /** 全行で揃えるレーン数。行ごとに変えると丸の位置が左右にぶれて追えなくなる。 */
  const lanes = $derived(Math.min(MAX_LANES, Math.max(1, ...rows.map((r) => r.width))));

  /** oid → その位置に先端があるブランチ。#20 に %D を足さず、取得済みの #3 の結果から引く。 */
  const refsByOid = $derived(groupRefsByOid(branches));

  /** 番兵行のぶんだけ 1 行多く見せる。 */
  const totalRows = $derived(commits.length + (complete ? 0 : 1));

  const view = $derived(computeWindow(totalRows, scrollTop, viewportHeight, { rowHeight: ROW_HEIGHT }));

  const visible = $derived(
    Array.from({ length: Math.max(0, view.endIndex - view.startIndex) }, (_, i) => view.startIndex + i),
  );

  // 番兵行が見えたら次のページ。onneedmore 側が二重呼び出しを弾く（logLoading で見張っている）
  $effect(() => {
    if (!complete && view.endIndex > commits.length) onneedmore();
  });

  function handleScroll(event: Event): void {
    const target = event.currentTarget as HTMLElement;
    scrollTop = target.scrollTop;
    viewportHeight = target.clientHeight;
  }
</script>

<div
  class="viewport"
  role="listbox"
  aria-label="コミット"
  onscroll={handleScroll}
  bind:clientHeight={viewportHeight}
>
  <div class="spacer" style:height={view.totalHeight + 'px'}>
    <div class="rows" style:transform={'translateY(' + view.paddingTop + 'px)'}>
      {#each visible as index (index)}
        {@const commit = commits[index]}
        {@const row = rows[index]}
        {#if commit === undefined || row === undefined}
          <div class="sentinel" style:height="{ROW_HEIGHT}px">
            {loading ? '読み込み中…' : 'さらに読み込みます…'}
          </div>
        {:else}
          <CommitRow
            {commit}
            {row}
            {lanes}
            height={ROW_HEIGHT}
            refs={refsByOid.get(commit.oid) ?? NO_REFS}
            selected={commit.oid === selectedOid}
            onselect={() => onselect(commit.oid)}
          />
        {/if}
      {/each}
    </div>
  </div>
</div>

<style>
  .viewport {
    flex: 1 1 auto;
    overflow: auto;
    min-height: 0;
  }

  .spacer {
    position: relative;
    min-width: 100%;
  }

  .rows {
    position: absolute;
    inset: 0 0 auto 0;
    will-change: transform;
  }

  .sentinel {
    display: flex;
    align-items: center;
    padding: 0 8px;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }
</style>
