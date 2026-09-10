<script lang="ts">
  import { app } from '../lib/appState.svelte.js';
  import PaneSplitter from './PaneSplitter.svelte';

  let liveHeight = $state<number | null>(null);
  const height = $derived(liveHeight ?? app.settings?.commandLogHeight ?? 220);

  function commitHeight(next: number): void {
    liveHeight = null;
    void app.setCommandLogHeight(next);
  }
</script>

<!--
  実行した git コマンドをすべて見せる。
  確認ダイアログを減らす代わりに透明性で信頼を担保する（決定 16）。
-->
<PaneSplitter
  axis="y"
  invert
  value={height}
  min={120}
  max={800}
  onchange={(h) => (liveHeight = h)}
  oncommit={commitHeight}
/>
<div class="panel" style:height={height + 'px'}>
  <header>
    <h2>実行ログ <span class="count">{app.commandLog.length}</span></h2>
    <button onclick={() => (app.showCommandLog = false)}>閉じる</button>
  </header>
  <div class="body">
    {#if app.commandLog.length === 0}
      <p class="empty">まだ git を実行していません。</p>
    {:else}
      <table>
        <tbody>
          {#each app.commandLog as entry (entry.seq)}
            <tr class:failed={entry.exitCode !== 0}>
              <td class="time">{entry.at.slice(11, 19)}</td>
              <td class="args">git {entry.args.join(' ')}</td>
              <td class="ms">{entry.elapsedMs} ms</td>
              <td class="code">{entry.exitCode === 0 ? '' : entry.exitCode}</td>
            </tr>
            {#if entry.stderr !== undefined && entry.stderr.length > 0}
              <tr class="stderr">
                <td></td>
                <td colspan="3">{entry.stderr}</td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 0 0 auto;
    border-top: 1px solid var(--app-border-strong);
    background: var(--app-bg-surface);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 8px;
    border-bottom: 1px solid var(--app-border-subtle);
  }

  h2 {
    margin: 0;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
    color: var(--app-text-secondary);
  }

  .count {
    color: var(--app-text-muted);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  td {
    padding: 1px 8px;
    vertical-align: top;
    white-space: nowrap;
  }

  .time,
  .ms,
  .code {
    color: var(--app-text-muted);
    width: 1%;
  }

  .args {
    white-space: pre-wrap;
    word-break: break-all;
  }

  tr.failed .args,
  tr.failed .code {
    color: var(--app-text-danger);
  }

  tr.stderr td {
    padding-bottom: 4px;
    color: var(--app-text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
  }

  .empty {
    margin: 12px;
    color: var(--app-text-muted);
  }
</style>
