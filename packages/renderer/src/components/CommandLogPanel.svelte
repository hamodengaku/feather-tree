<script lang="ts">
  import { app } from '../lib/appState.svelte.js';
  import PaneSplitter from './PaneSplitter.svelte';

  let liveHeight = $state<number | null>(null);
  const height = $derived(liveHeight ?? app.settings?.commandLogHeight ?? 220);
  const entries = $derived(app.visibleCommandLog);

  /**
   * パネルの内容（決定 26 の 2026-09-19 改定）。
   * 「コマンド」＝終わった git の記録、「エラー」＝操作の失敗。
   * 画面下端のエラー帯を廃止して、失敗をここへ集めた。突き合わせて読めるのが利点。
   *
   * 選択はこのコンポーネントの中だけに持つ（パネルを閉じるとコマンドへ戻る）。
   * 失敗が出ていることはタブのバッジが知らせるので、
   * 開いた時点でどちらを見るかは利用者が決められる。
   */
  let view = $state<'log' | 'errors'>('log');

  /**
   * 表示範囲。チェックボックスは「開いているすべてのリポジトリ」で、**既定はオフ**
   * （＝アクティブなタブの分だけ）。画面内だけの状態で、設定には保存しない。
   *
   * 以前は「このタブ」＝オンという逆向きの文言だったが、
   * チェックボックスでは「オンにすると範囲が広がる」ほうが読み違えにくい。
   */
  const thisTabOnly = $derived(app.commandLogScope === 'tab');

  /**
   * 失敗も表示範囲の対象にする（コマンド側と同じ規則。絞り込みは appState 側に置いてある）。
   *
   * **タブに属さない失敗（クローンはセッションが立つ前に走るので sessionId が null）は、
   * チェックを入れたときに出る。** オフのまま探しても見つからないので、
   * 空のときの文言でそのことを案内する。
   */
  const errors = $derived(app.visibleErrorLog);

  /** 見出しの件数。タブごとに数えているものが違う。 */
  const count = $derived(view === 'log' ? entries.length : errors.length);

  function commitHeight(next: number): void {
    liveHeight = null;
    void app.setCommandLogHeight(next);
  }

  /** 行に出すタブ名。タブに属さない実行・失敗（クローン）は —、閉じたタブは「閉じたタブ」。 */
  function tabName(sessionId: string | null): string {
    if (sessionId === null) return '—';
    return app.sessions.find((s) => s.id === sessionId)?.displayName ?? '閉じたタブ';
  }

  /** 失敗の時刻は Date.now() の数値で届く（実行ログの ISO 文字列とは形が違う）。 */
  function clock(at: number): string {
    const d = new Date(at);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /*
   * 空のときの文言。**チェックを入れれば見えるかもしれない**ことを必ず添える。
   * クローンの実行と失敗はタブに属さないので、オフのまま探しても永久に見つからない。
   */
  const emptyMessage = $derived(
    !thisTabOnly
      ? 'まだ git を実行していません。'
      : app.activeId === null
        ? 'タブを開いていません。「開いているすべてのリポジトリ」を選ぶと、クローンなどタブに属さない実行も出ます。'
        : 'このタブではまだ git を実行していません。「開いているすべてのリポジトリ」を選ぶと他のタブの分も出ます。',
  );

  const emptyErrorMessage = $derived(
    !thisTabOnly
      ? '失敗はまだありません。'
      : app.activeId === null
        ? 'タブを開いていません。「開いているすべてのリポジトリ」を選ぶと、クローンなどタブに属さない失敗も出ます。'
        : 'このタブではまだ失敗していません。「開いているすべてのリポジトリ」を選ぶと他のタブの分も出ます。',
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
    <!-- タイトルは固定。中身の切替はこの下のボタンで示す（2026-09-19 改定） -->
    <h2>実行ログ <span class="count">{count}</span></h2>
    <div class="scope" role="group" aria-label="表示する内容">
      <button
        type="button"
        class:active={view === 'log'}
        aria-pressed={view === 'log'}
        onclick={() => (view = 'log')}>コマンド</button
      >
      <button
        type="button"
        class:active={view === 'errors'}
        class:has-errors={errors.length > 0}
        aria-pressed={view === 'errors'}
        onclick={() => (view = 'errors')}
        >エラー{#if errors.length > 0}<span class="badge">{errors.length}</span>{/if}</button
      >
    </div>
    <!--
      表示範囲（2026-09-19 改定）。**既定はオフ**＝アクティブなタブの分だけ。
      入れると全タブ分に加えて、タブに属さない実行・失敗（クローン）と閉じたタブの分も出る。
      コマンドとエラーの両方に効く。設定には保存しない（起動のたびオフ）。
    -->
    <label class="scope-toggle">
      <input
        type="checkbox"
        checked={!thisTabOnly}
        onchange={(e) => app.setCommandLogScope(e.currentTarget.checked ? 'all' : 'tab')}
      />
      開いているすべてのリポジトリ
    </label>
    {#if view === 'errors'}
      <button type="button" disabled={app.errorLog.length === 0} onclick={() => app.clearErrorLog()}>
        消す
      </button>
    {/if}
    <button type="button" onclick={() => (app.showCommandLog = false)}>閉じる</button>
  </header>
  {#if view === 'errors'}
    <!--
      失敗の履歴（決定 26 の改定）。新しい順。
      原文（git の stderr）は訳した結果で情報を落とさないために必ず添える。
      文字列はそのまま差し込む（{@html} は使わない。リポジトリ内の文字列は信頼できない入力）。
    -->
    <div class="body">
      {#if errors.length === 0}
        <p class="empty">{emptyErrorMessage}</p>
      {:else}
        <ul class="errors">
          {#each errors as entry (entry.id)}
            <li>
              <div class="error-head">
                <span class="time">{clock(entry.at)}</span>
                <span class="message">{entry.message}</span>
                <span class="tab">{tabName(entry.sessionId)}</span>
              </div>
              {#if entry.detail !== undefined && entry.detail.length > 0}
                <p class="detail">{entry.detail}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else}
  <div class="body">
    {#if entries.length === 0}
      <p class="empty">{emptyMessage}</p>
    {:else}
      <table>
        <tbody>
          {#each entries as entry (entry.seq)}
            <tr class:failed={entry.exitCode !== 0}>
              <td class="time">{entry.at.slice(11, 19)}</td>
              <!-- タブ名は常に出す（「このタブ」の切替で列数が動くと行がずれて読みにくいため） -->
              <td class="tab" title={entry.cwd}>{tabName(entry.sessionId)}</td>
              <td class="args">git {entry.args.join(' ')}</td>
              <td class="ms">{entry.elapsedMs} ms</td>
              <td class="code">{entry.exitCode === 0 ? '' : entry.exitCode}</td>
            </tr>
            {#if entry.stderr !== undefined && entry.stderr.length > 0}
              <tr class="stderr">
                <td></td>
                <td colspan="4">{entry.stderr}</td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
  {/if}
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

  /* 内容の切替（コマンド／エラー）。右端へ寄せるのは表示範囲より後ろ（消す・閉じる）。 */
  .scope {
    display: flex;
    gap: 2px;
  }

  /* 表示範囲。ここで余剰幅を吸って、以降のボタンを右端へ送る。 */
  .scope-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-right: auto;
    color: var(--app-text-secondary);
    font-size: var(--app-font-size-ui);
    /* 文言が長いので、パネルを狭めたときに 2 行へ折れてヘッダの高さが動かないようにする */
    white-space: nowrap;
    user-select: none;
  }

  .scope-toggle input {
    margin: 0;
  }

  .scope button.active {
    color: var(--app-text-primary);
    border-color: var(--app-accent);
  }

  /* 失敗があることは、選んでいなくても分かるようにする（モーダルにはしない）。 */
  .scope button.has-errors {
    color: var(--app-text-danger);
  }

  .badge {
    margin-left: 4px;
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    font-weight: 700;
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
