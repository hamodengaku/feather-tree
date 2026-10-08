<script lang="ts">
  /*
   * Excel 差分モード（決定 33）のシートタブ。Excel と同じく下端に置き、左右のグリッドで共通。
   *
   * 印: + 追加 / − 削除 / ● 変更。名前が変わったシートは「旧 → 新」。非表示のシートは斜体。
   * 右端に「前の変更 / 次の変更」と「非表示も表示」を置く。
   * コンフリクトをセル単位で解消しているとき（決定 34）は、シートごとの未決定の数を添える。
   */
  import type { ExcelSheetLayoutDto, ExcelSheetSummaryDto } from '@feathertree/ipc';
  import { sheetLabel, sheetMarkSymbol } from '../lib/excelText.js';

  interface Props {
    sheets: readonly ExcelSheetSummaryDto[];
    current: number | null;
    layout: ExcelSheetLayoutDto | null;
    showHidden: boolean;
    onselect: (index: number) => void;
    onmove: (direction: 1 | -1) => void;
    ontogglehidden: () => void;
    /** シートごとの未決定の数（コンフリクトの解消中だけ）。 */
    unresolvedOf?: ((sheet: ExcelSheetSummaryDto) => number) | null;
  }

  const { sheets, current, layout, showHidden, onselect, onmove, ontogglehidden, unresolvedOf = null }: Props = $props();

  const currentSheet = $derived(sheets.find((s) => s.index === current) ?? null);
  const changeCount = $derived(layout?.changedRows.length ?? 0);

  function tabTitle(s: ExcelSheetSummaryDto): string {
    const lines = [sheetLabel(s)];
    if (s.mark === 'added') lines.push('追加されたシート');
    else if (s.mark === 'removed') lines.push('削除されたシート');
    else if (s.mark === 'changed') {
      lines.push(`変更 ${String(s.changedRows)} 行・追加 ${String(s.addedRows)} 行・削除 ${String(s.removedRows)} 行（${String(s.changedCells)} セル）`);
    } else {
      lines.push('値の変更なし');
    }
    if (s.hidden) lines.push('非表示のシート');
    return lines.join('\n');
  }
</script>

<div class="sheet-tabs">
  <div class="tabs" role="tablist" aria-label="シート">
    {#each sheets as s (s.index)}
      <button
        class="tab {s.mark}"
        class:active={s.index === current}
        class:hidden-sheet={s.hidden}
        role="tab"
        aria-selected={s.index === current}
        title={tabTitle(s)}
        onclick={() => onselect(s.index)}
      >
        {#if sheetMarkSymbol(s) !== ''}<span class="mark">{sheetMarkSymbol(s)}</span>{/if}
        <span class="name">{sheetLabel(s)}</span>
        {#if unresolvedOf !== null && unresolvedOf(s) > 0}
          <span class="unresolved" title="このシートの未決定の数">{unresolvedOf(s)}</span>
        {/if}
      </button>
    {/each}
  </div>

  <div class="tools">
    {#if currentSheet !== null && currentSheet.mark !== 'same'}
      <span class="summary">
        変更 {currentSheet.changedRows}・追加 {currentSheet.addedRows}・削除 {currentSheet.removedRows} 行
      </span>
    {/if}
    <button disabled={changeCount === 0} title="前の変更へ" onclick={() => onmove(-1)}>▲ 前の変更</button>
    <button disabled={changeCount === 0} title="次の変更へ" onclick={() => onmove(1)}>▼ 次の変更</button>
    <label class="toggle" title="非表示の行・列も出す（変更を含む非表示の行は常に出ます）">
      <input type="checkbox" checked={showHidden} onchange={ontogglehidden} />
      非表示も表示
    </label>
  </div>
</div>

<style>
  .unresolved {
    margin-left: 4px;
    padding: 0 4px;
    border-radius: var(--app-metric-radius);
    border: 1px solid var(--app-text-conflict);
    color: var(--app-text-conflict);
    font-size: var(--app-font-size-mono);
  }

  .sheet-tabs {
    display: flex;
    align-items: stretch;
    gap: var(--app-metric-gap);
    min-width: 0;
    border-top: 1px solid var(--app-border-strong);
    background: var(--app-bg-raised);
    font-size: var(--app-font-size-ui);
  }

  .tabs {
    flex: 1 1 auto;
    display: flex;
    min-width: 0;
    overflow-x: auto;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
    max-width: 240px;
    padding: 3px 12px;
    border: none;
    border-right: 1px solid var(--app-border-subtle);
    border-radius: 0;
    background: transparent;
    color: var(--app-text-secondary);
    white-space: nowrap;
  }

  .tab .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tab.active {
    background: var(--app-excel-paper);
    color: var(--app-excel-ink);
    font-weight: 700;
    box-shadow: inset 0 -2px 0 var(--app-excel-selection);
  }

  .tab.hidden-sheet .name {
    font-style: italic;
  }

  .tab.changed .mark {
    color: var(--app-text-modified);
  }

  .tab.added .mark {
    color: var(--app-text-added);
  }

  .tab.removed .mark {
    color: var(--app-text-removed);
  }

  .tools {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    white-space: nowrap;
  }

  .summary {
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--app-text-secondary);
  }
</style>
