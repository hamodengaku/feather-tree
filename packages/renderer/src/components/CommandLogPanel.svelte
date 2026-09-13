<script lang="ts">
  import { app } from '../lib/appState.svelte.js';
  import PaneSplitter from './PaneSplitter.svelte';

  let liveHeight = $state<number | null>(null);
  const height = $derived(liveHeight ?? app.settings?.commandLogHeight ?? 220);
  const entries = $derived(app.visibleCommandLog);
  const showTab = $derived(app.commandLogScope === 'all');

  function commitHeight(next: number): void {
    liveHeight = null;
    void app.setCommandLogHeight(next);
  }

  /** 「すべて」のときに出すタブ名。タブに属さない実行（クローン）は —、閉じたタブは「閉じたタブ」。 */
  function tabName(sessionId: string | null): string {
    if (sessionId === null) return '—';
    return app.sessions.find((s) => s.id === sessionId)?.displayName ?? '閉じたタブ';
  }

  const emptyMessage = $derived(
    app.commandLogScope === 'all'
      ? 'まだ git を実行していません。'
      : app.activeId === null
        ? 'タブを開いていません。クローンなどタブに属さない実行は「すべて」で見られます。'
        : 'このタブではまだ git を実行していません。',
  );
</script>

<!--
  実行した git コマンドをすべて見せる。
  確認ダイアログを減らす代わりに透明性で信頼を担保する（決定 16）。
  既定はアクティブなタブの実行だけ。「すべて」でタブに属さない実行（クローン）や閉じたタブの分も見る。
  中身は main の追記通知で増えるので、操作の種類によって表示が古いまま残ることはない。
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
    <h2>実行ログ <span class="count">{entries.length}</span></h2>
    <div class="scope" role="group" aria-label="表示範囲">
      <button
        type="button"
        class:active={app.commandLogScope === 'tab'}
        aria-pressed={app.commandLogScope === 'tab'}
        onclick={() => app.setCommandLogScope('tab')}>このタブ</button
      >
      <button
        type="button"
        class:active={app.commandLogScope === 'all'}
        aria-pressed={app.commandLogScope === 'all'}
        onclick={() => app.setCommandLogScope('all')}>すべて</button
      >
    </div>
    <button type="button" onclick={() => (app.showCommandLog = false)}>閉じる</button>
  </header>
  <div class="body">
    {#if entries.length === 0}
      <p class="empty">{emptyMessage}</p>
    {:else}
      <table>
        <tbody>
          {#each entries as entry (entry.seq)}
            <tr class:failed={entry.exitCode !== 0}>
              <td class="time">{entry.at.slice(11, 19)}</td>
              {#if showTab}
                <td class="tab" title={entry.cwd}>{tabName(entry.sessionId)}</td>
              {/if}
              <td class="args">git {entry.args.join(' ')}</td>
              <td class="ms">{entry.elapsedMs} ms</td>
              <td class="code">{entry.exitCode === 0 ? '' : entry.exitCode}</td>
            </tr>
            {#if entry.stderr !== undefined && entry.stderr.length > 0}
              <tr class="stderr">
                <td></td>
                <td colspan={showTab ? 4 : 3}>{entry.stderr}</td>
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
    gap: var(--app-metric-gap);
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

  /* 表示範囲の切替。閉じるボタンは右端へ寄せる。 */
  .scope {
    display: flex;
    gap: 2px;
    margin-right: auto;
  }

  .scope button.active {
    color: var(--app-text-primary);
    border-color: var(--app-accent);
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

  .tab {
    width: 1%;
    max-width: 16em;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--app-text-secondary);
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
