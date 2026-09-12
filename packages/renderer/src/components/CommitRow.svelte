<script lang="ts">
  /*
   * コミットリストの 1 行。
   *
   * 並びは「グラフ / ブランチ名 + 件名 / 作者 / ハッシュ / 日付」。
   * 幅が変わるのは件名の列だけで、他は固定幅にして縦に揃える（目で列を追えるようにする）。
   */
  import type { CommitSummaryDto } from '@feathertree/ipc';
  import type { CommitRef, GraphRow } from '../lib/commitGraph.js';
  import CommitGraphCell from './CommitGraphCell.svelte';

  interface Props {
    commit: CommitSummaryDto;
    row: GraphRow;
    /** リスト全体で揃えるレーン数。 */
    lanes: number;
    height: number;
    /** このコミットに先端があるブランチの短縮名（ローカルが先、リモートが後）。 */
    refs: readonly CommitRef[];
    selected: boolean;
    onselect: () => void;
  }

  const { commit, row, lanes, height, refs, selected, onselect }: Props = $props();

  /**
   * 日付の表示。年が今年なら省く（履歴は直近を見ることが多く、年が並ぶと件名の幅を食う）。
   * 作者日時（authoredAt）を出す。rebase しても「いつ書かれたか」は動かないため。
   */
  const dateText = $derived.by(() => {
    const at = new Date(commit.authoredAt);
    if (Number.isNaN(at.getTime())) return '';
    const p2 = (n: number): string => String(n).padStart(2, '0');
    const md = `${p2(at.getMonth() + 1)}-${p2(at.getDate())} ${p2(at.getHours())}:${p2(at.getMinutes())}`;
    return at.getFullYear() === new Date().getFullYear() ? md : `${String(at.getFullYear())}-${md}`;
  });

  const isMerge = $derived(commit.parents.length > 1);
</script>

<div
  class="commit-row"
  class:selected
  role="option"
  aria-selected={selected}
  tabindex="-1"
  style:height="{height}px"
  title={commit.subject}
  onclick={onselect}
  onkeydown={(event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onselect();
    }
  }}
>
  <CommitGraphCell {row} {lanes} {height} />

  <span class="subject">
    {#each refs as ref (ref.name)}
      <!-- ブランチ先端の名札。取得済みのブランチ一覧（#3）を oid で引いたもの -->
      <span class="ref" class:remote={ref.isRemote} class:head={ref.isHead}>{ref.name}</span>
    {/each}
    {#if isMerge}<span class="merge" title="マージコミット">⑂</span>{/if}
    <span class="subject-text">{commit.subject}</span>
  </span>

  <span class="author" title={commit.authorEmail}>{commit.authorName}</span>
  <span class="hash">{commit.shortOid}</span>
  <span class="date">{dateText}</span>
</div>

<style>
  .commit-row {
    display: flex;
    align-items: center;
    gap: var(--app-metric-gap);
    padding: 0 8px;
    white-space: nowrap;
    cursor: default;
  }

  .commit-row:hover {
    background: var(--app-bg-hover);
  }

  .commit-row.selected {
    background: var(--app-bg-selected);
  }

  .commit-row:focus-visible {
    outline: 1px solid var(--app-accent);
    outline-offset: -1px;
  }

  /* 件名だけが伸び縮みする。min-width: 0 が無いと長い件名が他の列を押し出す。 */
  .subject {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .subject-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /*
    ブランチ先端の名札。丸めた枠で「これは件名ではない」ことを示す。
    ローカルはアクセント、リモートは一段落とした色にして、どちらを指しているか一目で分かるようにする。
  */
  .ref {
    flex: 0 0 auto;
    padding: 0 6px;
    border: 1px solid var(--app-accent);
    border-radius: var(--app-metric-radius-pill);
    color: var(--app-accent);
    font-size: var(--app-font-size-mono);
    line-height: 15px;
  }

  .ref.remote {
    border-color: var(--app-text-untracked);
    color: var(--app-text-untracked);
  }

  /* 今いるブランチ。ここだけ塗りつぶして、他の名札と間違えないようにする。 */
  .ref.head {
    background: var(--app-accent);
    border-color: var(--app-accent);
    color: var(--app-bg-surface);
    font-weight: 700;
  }

  .merge {
    flex: 0 0 auto;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .author {
    flex: 0 0 auto;
    width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--app-text-secondary);
    font-size: var(--app-font-size-mono);
  }

  .hash {
    flex: 0 0 auto;
    width: 62px;
    color: var(--app-text-muted);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .date {
    flex: 0 0 auto;
    width: 104px;
    text-align: right;
    color: var(--app-text-muted);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }
</style>
