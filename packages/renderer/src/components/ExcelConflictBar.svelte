<script lang="ts">
  /*
   * Excel 差分モードのコンフリクトの帯（決定 34。配置は docs/07 7.0）。値バーの上に出す。
   *
   * 置くもの: 「コンフリクト」の印、マージをキャンセルする（対応表 #51。確認あり）、未決定の数、次の未決定へ、
   * 指定をすべて外す、書き込む。セル・行・列の採り方は選択と右クリックで、残りすべては右クリックで決める。
   * ファイル単位の採用は左右のペインの見出しの右端（ExcelPane）。
   *
   * 相手側を採れない所（docs/07 3.2）に相手側が指定されている間は書き込めない（その所へ移るボタンを出す）。
   * 書き込むのは作業ツリーだけで、解決済みにするのは差分モードでのステージ（決定 30 と同じ）。
   */
  import type { ExcelConflictDto, ExcelViewDto } from '@feathertree/ipc';
  import { app } from '../lib/appState.svelte.js';
  import { blockedChoices, toChoicesDto, unresolvedCount } from '../lib/excelConflict.js';

  interface Props {
    view: ExcelViewDto;
    conflict: ExcelConflictDto;
  }

  const { view, conflict }: Props = $props();
  const ex = app.excel;

  const cellMode = $derived(conflict.cellResolvable && view.sheets.length > 0 && view.sheets.every((s) => s.conflict != null));
  const unresolved = $derived(unresolvedCount(view.sheets, ex.choices));
  const blocked = $derived(blockedChoices(view.sheets, ex.choices));

  function writeCells(): void {
    void app.resolveExcelConflict({ kind: 'cells', choices: toChoicesDto(ex.choices) });
  }

  /** 相手側を採れない所に相手側が指定されている最初の所へ。 */
  async function showBlocked(): Promise<void> {
    const first = blocked.first;
    if (first === null) return;
    if (first.sheet !== ex.sheet) await ex.selectSheet(first.sheet);
    await ex.selectCell(first.row, first.col);
  }

  const writeTitle = $derived(
    unresolved !== 0
      ? 'すべての違いを決めると書き込めます'
      : blocked.count > 0
        ? 'theirs を採れない所に theirs が指定されています'
        : '決めた内容で作業ツリーのファイルを書き換えます（解決済みにするには、差分モードでステージしてください）',
  );
</script>

<div class="conflict-bar" role="region" aria-label="コンフリクトの解消">
  <span
    class="badge"
    title={cellMode ? undefined : 'このファイルはファイル全体でのみ採用できます（左右のペインの右上のボタン）'}>コンフリクト</span
  >
  <button
    class="abort"
    disabled={app.busy}
    title="作業ツリーと index をマージを始める前に戻します（確認があります）"
    onclick={() => void app.abortMerge()}>マージをキャンセルする</button
  >
  <span class="spacer"></span>
  {#if cellMode}
    <span class="count" class:done={unresolved === 0}>未決定 {unresolved ?? 0} 件</span>
    {#if blocked.count > 0}
      <button class="blocked-button" onclick={() => void showBlocked()}>theirs を採れない所 {blocked.count} 件</button>
    {/if}
    <button onclick={() => void ex.moveToUnresolved()} disabled={unresolved === 0}>次の未決定へ</button>
    <button onclick={() => ex.clearChoices()}>指定をすべて外す</button>
    <button class="primary" disabled={app.busy || unresolved !== 0 || blocked.count > 0} title={writeTitle} onclick={writeCells}>
      書き込む
    </button>
  {/if}
</div>

<style>
  .conflict-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--app-border-subtle);
    background: var(--app-bg-raised);
    font-size: var(--app-font-size-ui);
  }

  .badge {
    flex: 0 0 auto;
    padding: 0 6px;
    border-radius: var(--app-metric-radius);
    border: 1px solid var(--app-text-conflict);
    color: var(--app-text-conflict);
    font-weight: 700;
  }

  /* マージをキャンセルする: 取り返しの付きにくい操作なので、少し目立たせる */
  .abort:not(:disabled) {
    border-color: var(--app-text-danger);
    color: var(--app-text-danger);
    font-weight: 700;
  }

  .abort:not(:disabled):hover {
    background: color-mix(in srgb, var(--app-text-danger) 12%, transparent);
  }

  .spacer {
    flex: 1 1 auto;
  }

  .count {
    color: var(--app-text-conflict);
    font-weight: 700;
  }

  .count.done {
    color: var(--app-text-added);
  }

  .blocked-button {
    color: var(--app-text-danger);
  }

  button.primary:not(:disabled) {
    border-color: var(--app-accent);
    color: var(--app-accent);
    font-weight: 700;
  }
</style>
