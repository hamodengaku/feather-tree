<script lang="ts">
  /*
   * Excel 差分モード（決定 33）の値バー。選んだセルの旧値・新値・数式を、下のグリッドと同じ
   * 左右の並び（左 = 旧版、右 = 新版）で出す。セルの中で切れた長い文字もここで全文読める。
   *
   * 値は表示形式を当てたもの（M3）。生の値（日付のシリアル値・丸める前の数値）が違えば添える。
   * 数式は先頭に = を付けて出す。
   */
  import type { ExcelCellDetailDto, ExcelCellSideDto } from '@feathertree/ipc';

  interface Props {
    cell: ExcelCellDetailDto | null;
  }

  const { cell }: Props = $props();

  /** 見えている値（表示形式を当てたもの。M3）。 */
  function valueOf(side: ExcelCellSideDto | null): string {
    if (side === null) return '';
    return side.display;
  }

  /** 生の値が表示と違うときだけ添える（日付のシリアル値・丸める前の数値）。 */
  function rawOf(side: ExcelCellSideDto | null): string | null {
    if (side === null || side.raw === side.display || side.raw === '') return null;
    return side.raw;
  }
</script>

{#snippet half(side: ExcelCellSideDto | null, label: string)}
  <div class="half" class:changed={cell?.changed === true}>
    <span class="label">{label}</span>
    {#if cell === null}
      <span class="muted">セルを選ぶと値を表示します</span>
    {:else if side === null}
      <span class="muted">（この側には行がありません）</span>
    {:else}
      <span class="address">{side.address}</span>
      {#if side.formula !== null}
        <span class="formula" title={'=' + side.formula}>={side.formula}</span>
      {/if}
      <span class="value" title={valueOf(side)}>{valueOf(side) === '' ? '（空）' : valueOf(side)}</span>
      {#if rawOf(side) !== null}
        <span class="raw" title="セルに保存されている値">生の値 {rawOf(side)}</span>
      {/if}
    {/if}
  </div>
{/snippet}

<div class="value-bar">
  {@render half(cell?.old ?? null, '旧')}
  <div class="divider" aria-hidden="true"></div>
  {@render half(cell?.new ?? null, '新')}
</div>

<style>
  .value-bar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 1px minmax(0, 1fr);
    min-width: 0;
    border-bottom: 1px solid var(--app-border-subtle);
    background: var(--app-bg-surface);
    font-size: var(--app-font-size-ui);
  }

  .divider {
    background: var(--app-border-strong);
  }

  .half {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    padding: 4px 8px;
    white-space: nowrap;
    overflow: hidden;
  }

  .half.changed .value {
    background: var(--app-excel-changed-bg);
    color: var(--app-excel-ink);
  }

  .label {
    flex: 0 0 auto;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .address {
    flex: 0 0 auto;
    font-family: var(--app-font-mono);
    font-weight: 700;
  }

  .formula {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--app-font-mono);
    color: var(--app-text-secondary);
  }

  .value {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 4px;
    border-radius: var(--app-metric-radius);
  }

  .raw {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--app-text-muted);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .muted {
    color: var(--app-text-muted);
  }
</style>
