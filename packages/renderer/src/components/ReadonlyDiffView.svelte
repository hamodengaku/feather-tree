<script lang="ts">
  /*
   * 読み取り専用の unified diff。コミット詳細ペイン（決定 27）で使う。
   *
   * **panes/DiffPane.svelte とは別物にしてある。** あちらは作業ツリーの差分を「ステージする／
   * 戻す」ための道具で、hunk ボタンと 1 行モードが本体に織り込まれている。
   * 過去のコミットに対してそれらは一切成り立たない（#33 / #34 は作業ツリー専用）ので、
   * 操作の口を持たないこちらを用意して、**ステージの仕組みが履歴側へ漏れない**ようにしている。
   * 行の描画とその CSS は両者で似るが、それは重複ではなく「同じ見た目の別の道具」。
   */
  import type { DiffHunkDto, DiffLineDto, FileDiffDto } from '@feathertree/ipc';

  interface Props {
    diff: FileDiffDto | null;
    loading: boolean;
    /** 差分が無いときに出す文言。呼び出し側の文脈（未選択・マージ等）で変わる。 */
    emptyText: string;
  }

  const { diff, loading, emptyText }: Props = $props();

  /** hunk ヘッダの表示。git の生ヘッダ末尾に付く関数名は出さず、行番号だけを組み立て直す。 */
  function headerText(hunk: DiffHunkDto): string {
    return `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`;
  }
</script>

{#snippet lineCells(line: DiffLineDto)}
  <span class="no">{line.oldLineNo ?? ''}</span>
  <span class="no">{line.newLineNo ?? ''}</span>
  <span class="sign">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span>
  <span class="text">{line.text}</span>
{/snippet}

<div class="body">
  {#if loading}
    <p class="empty">読み込み中…</p>
  {:else if diff === null}
    <p class="empty">{emptyText}</p>
  {:else if diff.binary}
    <p class="empty">バイナリファイルのため差分を表示できません。</p>
  {:else if diff.hunks.length === 0}
    <p class="empty">差分はありません。</p>
  {:else}
    <div class="diff">
      {#each diff.hunks as hunk, hunkIndex (hunkIndex)}
        <div class="hunk-header"><span class="hunk-text">{headerText(hunk)}</span></div>
        {#each hunk.lines as line, i (i)}
          <div class="line {line.kind}">{@render lineCells(line)}</div>
        {/each}
      {/each}
      {#if diff.truncated}
        <div class="hunk-header">
          <span class="hunk-text">これ以降は行数上限により省略されました。</span>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .body {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }

  .empty {
    margin: 16px;
    color: var(--app-text-muted);
  }

  .diff {
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    line-height: 17px;
    min-width: max-content;
  }

  .hunk-header {
    display: flex;
    align-items: center;
    padding: 2px 8px;
    color: var(--app-text-secondary);
    background: var(--app-bg-raised);
    border-top: 1px solid var(--app-border-subtle);
    border-bottom: 1px solid var(--app-border-subtle);
  }

  /* 横スクロールしても @@ の表示が消えないよう、文字だけ左端に貼り付ける */
  .hunk-text {
    position: sticky;
    left: 8px;
    white-space: pre;
  }

  .line {
    display: flex;
    white-space: pre;
  }

  .line.added {
    background: var(--app-diff-added-bg);
  }

  .line.removed {
    background: var(--app-diff-removed-bg);
  }

  .no {
    flex: 0 0 auto;
    width: 46px;
    padding-right: 8px;
    text-align: right;
    color: var(--app-text-muted);
    user-select: none;
  }

  .sign {
    flex: 0 0 auto;
    width: 14px;
    text-align: center;
    user-select: none;
  }

  .line.added .sign,
  .line.added .text {
    color: var(--app-text-added);
  }

  .line.removed .sign,
  .line.removed .text {
    color: var(--app-text-removed);
  }

  .line.no-newline .text {
    color: var(--app-text-muted);
    font-style: italic;
  }
</style>
