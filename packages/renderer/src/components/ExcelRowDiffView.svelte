<script lang="ts">
  /*
   * 差分モードの「行単位の比較」（決定 33 の C 案）。**読むだけ**で、hunk ボタンは出さない。
   *
   * 行を 1 レコードとみなし、変わった行と前後の文脈行をシートごとに表で出す。変更の行は
   * 旧（−）と新（+）の 2 段にし、値が変わった列だけを強調する。列の挿入・削除は検出しない
   * （同じ列番号どうしで比べる。決定 33 の既知の限界）。
   */
  import type { ExcelRowDiffDto, ExcelRowDiffRowDto } from '@feathertree/ipc';
  import { columnLabel } from '../lib/excelGrid.js';
  import { sideNotice } from '../lib/excelText.js';

  interface Props {
    diff: ExcelRowDiffDto;
  }

  const { diff }: Props = $props();

  const oldNotice = $derived(sideNotice('old', diff.old.state));
  const newNotice = $derived(sideNotice('new', diff.new.state));
  // 片側が無い（新規・削除）のは普通のことなので、行の比較（全行が追加 / 削除）をそのまま出す
  const blocking = $derived(
    (oldNotice !== null && diff.old.state !== 'absent') || (newNotice !== null && diff.new.state !== 'absent'),
  );

  function sheetTitle(s: ExcelRowDiffDto['sheets'][number]): string {
    const name = s.renamed ? `${s.oldName ?? ''} → ${s.newName ?? ''}` : (s.newName ?? s.oldName ?? '');
    const mark = s.mark === 'added' ? '（追加）' : s.mark === 'removed' ? '（削除）' : s.renamed && s.mark === 'same' ? '（名前の変更のみ）' : '';
    return name + mark;
  }

  function rowNumber(n: number): string {
    return n < 0 ? '' : String(n + 1);
  }

  /** 表の 1 段。変更の行は旧・新の 2 段になる。 */
  interface Line {
    readonly key: string;
    readonly sign: string;
    readonly tone: string;
    readonly no: string;
    readonly cells: readonly string[];
    readonly changed: readonly number[];
  }

  function linesOf(row: ExcelRowDiffRowDto, key: string): Line[] {
    if (row.kind === 'same') {
      return [{ key, sign: '', tone: 'same', no: rowNumber(row.newRow), cells: row.new ?? row.old ?? [], changed: [] }];
    }
    const out: Line[] = [];
    if (row.old !== null) {
      out.push({ key: key + 'o', sign: '−', tone: 'removed', no: rowNumber(row.oldRow), cells: row.old, changed: row.changed });
    }
    if (row.new !== null) {
      out.push({ key: key + 'n', sign: '+', tone: 'added', no: rowNumber(row.newRow), cells: row.new, changed: row.changed });
    }
    return out;
  }
</script>

<div class="row-diff">
  {#if blocking}
    {#if oldNotice !== null && diff.old.state !== 'absent'}<p class="notice">旧版（HEAD）: {oldNotice}</p>{/if}
    {#if newNotice !== null && diff.new.state !== 'absent'}<p class="notice">新版（作業ツリー）: {newNotice}</p>{/if}
  {/if}
  <p class="notice info">
    Excel のため、HEAD と作業ツリーを行単位で比べています（ステージ済み／未ステージを区別しません）。
    列の挿入・削除は見分けられません。
    {#if diff.vbaChanged === true}<strong>マクロが変更されています。</strong>{/if}
  </p>

  {#if diff.sheets.length === 0 && !blocking}
    <p class="empty">値の変更はありません（書式だけの変更は数えていません）。</p>
  {/if}

  {#each diff.sheets as s (s.index)}
    <section class="sheet">
      <h3>{sheetTitle(s)}</h3>
      {#if s.positional}
        <p class="notice">変更が多すぎるため、一部の行は位置で対応付けています。</p>
      {/if}
      {#each s.hunks as hunk, h (h)}
        <table class="hunk">
          <thead>
            <tr>
              <th class="sign"></th>
              <th class="no"></th>
              {#each hunk.columns as c (c)}<th>{columnLabel(c)}</th>{/each}
            </tr>
          </thead>
          <tbody>
            {#each hunk.rows as row, r (r)}
              {#each linesOf(row, String(r)) as line (line.key)}
                <tr class={line.tone}>
                  <td class="sign">{line.sign}</td>
                  <td class="no">{line.no}</td>
                  {#each line.cells as text, i (i)}
                    <td class:changed={line.changed.includes(i)} title={text}>{text}</td>
                  {/each}
                </tr>
              {/each}
            {/each}
          </tbody>
        </table>
      {/each}
    </section>
  {/each}

  {#if diff.truncated}
    <p class="notice">行数の上限に達したため、ここから先は省略しました。Excel モードで開くと全体を見られます。</p>
  {/if}
</div>

<style>
  .row-diff {
    min-width: max-content;
    font-size: var(--app-font-size-mono);
  }

  .notice {
    position: sticky;
    left: 0;
    margin: 0;
    padding: 6px 8px;
    background: var(--app-bg-raised);
    border-bottom: 1px solid var(--app-border-subtle);
    color: var(--app-text-conflict);
    line-height: 1.5;
    white-space: normal;
    max-width: 100vw;
  }

  .notice.info {
    color: var(--app-text-secondary);
  }

  .empty {
    margin: 16px;
    color: var(--app-text-muted);
  }

  .sheet {
    margin: 8px;
  }

  h3 {
    position: sticky;
    left: 8px;
    display: inline-block;
    margin: 4px 0;
    font-size: var(--app-font-size-ui);
  }

  .hunk {
    border-collapse: collapse;
    margin-bottom: 8px;
    background: var(--app-excel-paper);
    color: var(--app-excel-ink);
  }

  th,
  td {
    max-width: 240px;
    padding: 1px 6px;
    border: 1px solid var(--app-excel-grid-line);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
    text-align: left;
  }

  th {
    background: var(--app-bg-raised);
    color: var(--app-text-secondary);
    font-weight: 400;
    text-align: center;
  }

  .sign,
  .no {
    color: var(--app-text-muted);
    text-align: right;
    background: var(--app-bg-raised);
  }

  tr.added td:not(.sign):not(.no) {
    background: var(--app-excel-added-bg);
  }

  tr.removed td:not(.sign):not(.no) {
    background: var(--app-excel-removed-bg);
  }

  /* 追加・削除の地の色より強く出す（上の規則より詳細度を 1 段上げる） */
  tr.added td.changed:not(.sign):not(.no),
  tr.removed td.changed:not(.sign):not(.no) {
    background: var(--app-excel-changed-bg);
    box-shadow: inset 0 0 0 1px var(--app-excel-changed-outline);
  }
</style>
