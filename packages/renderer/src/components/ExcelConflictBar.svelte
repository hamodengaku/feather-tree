<script lang="ts">
  /*
   * Excel 差分モードのコンフリクトの帯（決定 34）。値バーの上に出す。
   *
   * 1 段目: 何が起きているか（出どころ・作業ツリーの様子）と、ファイル単位の採用。
   * 2 段目（CSV のマーカー方式だけ）: 選んでいるセル・その行・その列・残りすべての採り方と、書き込み。
   *
   * 採り方のボタンは押し直すと外れる（aria-pressed で今の指定を示す）。書き込むのは作業ツリーだけで、
   * 解決済みにするのは差分モードでのステージ（決定 30 と同じ）。
   */
  import type { ExcelConflictDto, ExcelViewDto } from '@feathertree/ipc';
  import { app } from '../lib/appState.svelte.js';
  import {
    choiceForCell,
    choiceForRow,
    isOneSidedRow,
    toChoicesDto,
    unresolvedCount,
    type ConflictSide,
  } from '../lib/excelConflict.js';
  import { columnLabel } from '../lib/excelGrid.js';
  import { conflictSummary } from '../lib/excelText.js';

  interface Props {
    view: ExcelViewDto;
    conflict: ExcelConflictDto;
  }

  const { view, conflict }: Props = $props();
  const ex = app.excel;

  const layout = $derived(ex.layout);
  const sel = $derived(ex.selection);
  const oursAbsent = $derived(view.old.state === 'absent');
  const theirsAbsent = $derived(view.new.state === 'absent');
  const cellMode = $derived(conflict.cellResolvable && layout !== null && layout.conflictCells != null);
  const unresolved = $derived(layout === null ? null : unresolvedCount(layout, ex.choices));
  const oneSided = $derived(layout !== null && sel !== null && isOneSidedRow(layout, sel.row));

  /** 選んでいる所の、今効いている採り方（どの指定から来たかは問わない）。 */
  const effective = $derived.by((): ConflictSide | null => {
    if (layout === null || sel === null) return null;
    return oneSided ? choiceForRow(ex.choices, sel.row) : choiceForCell(ex.choices, sel.row, sel.col);
  });
  const cellPick = $derived(sel === null ? null : (ex.conflictCells.get(sel.row + ':' + sel.col) ?? null));
  const rowPick = $derived(sel === null ? null : (ex.conflictRows.get(sel.row) ?? null));
  const colPick = $derived(sel === null ? null : (ex.conflictCols.get(sel.col) ?? null));

  /** 選んでいる所の見出し（行番号は自分側、無ければ相手側の行番号）。 */
  const where = $derived.by(() => {
    if (layout === null || sel === null) return null;
    const o = layout.oldRow[sel.row] ?? -1;
    const n = layout.newRow[sel.row] ?? -1;
    const row = o >= 0 ? o : n;
    if (row < 0) return null;
    return oneSided ? `${String(row + 1)} 行` : columnLabel(sel.col) + String(row + 1);
  });

  function sideText(side: ConflictSide | null): string {
    return side === 'ours' ? '自分側' : side === 'theirs' ? '相手側' : '未決定';
  }

  function adoptFile(side: ConflictSide): void {
    void app.resolveExcelConflict({ kind: 'file', side });
  }

  function writeCells(): void {
    void app.resolveExcelConflict({ kind: 'cells', choices: toChoicesDto(ex.choices) });
  }
</script>

{#snippet pair(label: string, current: ConflictSide | null, choose: (side: ConflictSide) => void, disabled: boolean)}
  <span class="group">
    <span class="group-label">{label}</span>
    <button class="ours" aria-pressed={current === 'ours'} {disabled} onclick={() => choose('ours')}>自分側</button>
    <button class="theirs" aria-pressed={current === 'theirs'} {disabled} onclick={() => choose('theirs')}>相手側</button>
  </span>
{/snippet}

<div class="conflict-bar" role="region" aria-label="コンフリクトの解消">
  <div class="line">
    <span class="badge">コンフリクト</span>
    <span class="summary">{conflictSummary(conflict)}</span>
    <span class="spacer"></span>
    <span class="group">
      <span class="group-label">ファイル全体</span>
      <button
        class="ours"
        disabled={app.busy || oursAbsent}
        title={oursAbsent ? '自分側では削除されています（削除は差分モードで行ってください）' : '作業ツリーを自分側の内容にします'}
        onclick={() => adoptFile('ours')}>自分側を採用</button
      >
      <button
        class="theirs"
        disabled={app.busy || theirsAbsent}
        title={theirsAbsent ? '相手側では削除されています（削除は差分モードで行ってください）' : '作業ツリーを相手側の内容にします'}
        onclick={() => adoptFile('theirs')}>相手側を採用</button
      >
    </span>
  </div>

  {#if cellMode}
    <div class="line cells">
      <span class="where">{where ?? 'セル未選択'}：{sideText(effective)}</span>
      {#if oneSided}
        {@render pair('この行（片側だけの行）', rowPick, (s) => ex.chooseRow(s), sel === null)}
      {:else}
        {@render pair('このセル', cellPick, (s) => ex.chooseCell(s), sel === null)}
        {@render pair('この行', rowPick, (s) => ex.chooseRow(s), sel === null)}
        {@render pair('この列', colPick, (s) => ex.chooseCol(s), sel === null)}
      {/if}
      {@render pair('残りすべて', ex.conflictRest, (s) => ex.chooseRest(s), false)}
      <span class="spacer"></span>
      <button onclick={() => void ex.moveToUnresolved()} disabled={unresolved === 0}>次の未決定へ</button>
      <button onclick={() => ex.clearChoices()}>指定をすべて外す</button>
      <button
        class="primary"
        disabled={app.busy || unresolved !== 0}
        title={unresolved === 0 ? '決めた内容で作業ツリーのファイルを書き換えます' : 'すべての違いを決めると書き込めます'}
        onclick={writeCells}
      >
        書き込む{#if unresolved !== null && unresolved > 0}（未決定 {unresolved} 件）{/if}
      </button>
    </div>
  {:else if conflict.source === 'markers'}
    <p class="note">違いが多すぎる・上限で途中までしか読んでいないため、ファイル全体でのみ採用できます。</p>
  {/if}
  <p class="note">
    採用は作業ツリーのファイルを書き換えるだけです。解決済みにするには、差分モードでこのファイルをステージしてください。
  </p>
</div>

<style>
  .conflict-bar {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--app-border-subtle);
    background: var(--app-bg-raised);
    font-size: var(--app-font-size-ui);
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    min-width: 0;
  }

  .badge {
    flex: 0 0 auto;
    padding: 0 6px;
    border-radius: var(--app-metric-radius);
    border: 1px solid var(--app-text-conflict);
    color: var(--app-text-conflict);
    font-weight: 700;
  }

  .summary {
    min-width: 0;
    color: var(--app-text-secondary);
  }

  .spacer {
    flex: 1 1 auto;
  }

  .group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .group-label,
  .where {
    color: var(--app-text-muted);
  }

  .where {
    font-family: var(--app-font-mono);
  }

  button.ours[aria-pressed='true'] {
    background: var(--app-conflict-ours-bg);
    outline: 2px solid var(--app-text-conflict);
  }

  button.theirs[aria-pressed='true'] {
    background: var(--app-conflict-theirs-bg);
    outline: 2px solid var(--app-text-conflict);
  }

  button.primary:not(:disabled) {
    border-color: var(--app-accent);
    color: var(--app-accent);
    font-weight: 700;
  }

  .note {
    margin: 0;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }
</style>
