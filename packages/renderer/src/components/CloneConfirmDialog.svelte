<script lang="ts">
  import type { CloneMode } from '@feathertree/ipc';
  import { app } from '../lib/appState.svelte.js';
  import { copyText } from '../lib/clipboard.js';
  import { joinPreview } from '../lib/cloneForm.js';
  import { outcomeHeading, showsLog } from '../lib/cloneProgressView.js';
  import CloneProgressPanel from './CloneProgressPanel.svelte';

  const MODE_LABEL: Record<CloneMode, string> = {
    normal: '通常',
    shallow: '最新コミットのみ（シャロー）',
    large: '大規模リポジトリ向け（自動）',
  };

  /** 直前にコピーしたもの（押したボタンの文字を「コピーしました」にする）。 */
  let copied = $state<string | null>(null);
  let copyFailed = $state(false);

  async function copy(key: string, text: string): Promise<void> {
    const ok = await copyText(text);
    copied = ok ? key : null;
    copyFailed = !ok;
  }

  async function run(): Promise<void> {
    const request = app.cloneConfirm;
    if (request === null || app.cloning) return;
    copied = null;
    copyFailed = false;
    await app.cloneRepository(request);
  }

  /** 背景を押したとき：実行前は入力へ戻る、実行中は何もしない、終わったら閉じる。 */
  function onBackdrop(): void {
    if (app.cloning) return;
    if (app.cloneOutcome === null) app.backToCloneForm();
    else app.closeCloneDialog();
  }
</script>

<!--
  クローンの最終確認と、実行・進捗・結果（決定 9 / 対応表 #37〜#41）。入力ダイアログ（CloneDialog）の「決定」で開く。
  決定 16 の破壊的操作の確認とは別物で、main は強制しない（renderer の中だけの確認）。

  実行する git コマンドはここに出さない。共通オプションなど見慣れない引数が並ぶと、
  一般の利用者が不安になるため。実行した内容はコマンドログと、失敗時の生ログに残る。

  「実行」を押すとボタン行の下に進捗が伸びる。完了しても自動では閉じない
  （シャローの推奨コマンド・失敗時のヒント・生ログを読ませるため）。
-->
{#if app.cloneConfirm !== null}
  {@const request = app.cloneConfirm}
  <div class="backdrop" role="presentation" onclick={onBackdrop}></div>
  <div class="dialog" role="dialog" aria-labelledby="clone-confirm-title" aria-busy={app.cloning}>
    <h2 id="clone-confirm-title">クローンの確認</h2>

    <dl class="summary">
      <dt>URL</dt>
      <dd class="mono">{request.url}</dd>
      <dt>作成先</dt>
      <dd class="mono">{joinPreview(request.parentDir, request.name)}</dd>
      <dt>クローン方法</dt>
      <dd>{MODE_LABEL[request.mode]}</dd>
    </dl>

    <div class="actions">
      {#if app.cloning}
        <button type="button" disabled={app.cancellingClone} onclick={() => void app.cancelClone()}>
          {app.cancellingClone ? '中止しています…' : 'キャンセル'}
        </button>
      {:else if app.cloneOutcome !== null}
        {#if app.cloneOutcome.result === 'failed'}
          <button type="button" onclick={() => app.backToCloneForm()}>戻る</button>
        {/if}
        <button type="button" onclick={() => app.closeCloneDialog()}>閉じる</button>
      {:else}
        <button type="button" onclick={() => app.backToCloneForm()}>戻る</button>
        <button type="button" disabled={app.busy} onclick={() => void run()}>実行</button>
      {/if}
    </div>

    {#if app.cloning || app.cloneOutcome !== null}
      <div class="lower">
        {#if app.cloneStages !== null && app.cloneStages.length > 0}
          <CloneProgressPanel stages={app.cloneStages} running={app.cloning} />
        {:else if app.cloning}
          <p class="waiting">クローンを開始しています…</p>
        {/if}

        {#if app.cloneOutcome !== null}
          {@const outcome = app.cloneOutcome}
          <section class="outcome" aria-live="polite">
            <h3 class="heading" class:bad={outcome.result !== 'succeeded' || outcome.cancelled}>
              {outcomeHeading(outcome)}
            </h3>

            {#each outcome.hints as hint (hint.id)}
              <div class="hint">
                <p class="hint-title">{hint.title}</p>
                <p class="hint-body">{hint.body}</p>
                {#each hint.commands as command, i (i)}
                  {@const key = hint.id + ':' + String(i)}
                  <div class="cmd-row">
                    <code class="cmd">{command}</code>
                    <button type="button" class="copy" onclick={() => void copy(key, command)}>
                      {copied === key ? 'コピーしました' : 'コピー'}
                    </button>
                  </div>
                {/each}
              </div>
            {/each}

            {#if outcome.followUps.length > 0}
              <div class="hint">
                <p class="hint-title">
                  {outcome.result === 'succeeded' ? 'のちほど履歴を取り戻す手順' : '残りの手順'}
                </p>
                <p class="hint-body">
                  クローンしたフォルダ（<span class="mono">{outcome.target}</span>）で、次を上から順に実行してください。
                </p>
                {#each outcome.followUps as command, i (i)}
                  {@const key = 'follow:' + String(i)}
                  <div class="cmd-row">
                    <code class="cmd">{command}</code>
                    <button type="button" class="copy" onclick={() => void copy(key, command)}>
                      {copied === key ? 'コピーしました' : 'コピー'}
                    </button>
                  </div>
                {/each}
              </div>
            {/if}

            {#if showsLog(outcome)}
              <div class="log">
                <div class="log-actions">
                  <button type="button" onclick={() => void copy('log', outcome.log)}>
                    {copied === 'log' ? 'コピーしました' : 'ログをコピー'}
                  </button>
                  <span class="note">メモ帳などに貼り付けて保存しておくことをおすすめします</span>
                </div>
                <details>
                  <summary>ログを表示</summary>
                  <pre class="log-text">{outcome.log}</pre>
                </details>
              </div>
            {/if}

            {#if copyFailed}
              <p class="note">コピーできませんでした。「ログを表示」を開いて選択してください。</p>
            {/if}
          </section>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--app-layer-modal-backdrop);
    background: rgb(0 0 0 / 45%);
  }

  /* 進捗と結果で縦に伸びる。画面の 90% で止め、そこから先は下の領域だけをスクロールさせる。 */
  .dialog {
    position: fixed;
    z-index: var(--app-layer-modal);
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    width: min(640px, 92vw);
    max-height: 90vh;
    padding: 18px 20px;
    background: var(--app-bg-surface);
    border: 1px solid var(--app-border-strong);
    border-radius: var(--app-metric-radius);
    box-shadow: 0 8px 32px rgb(0 0 0 / 40%);
  }

  h2 {
    margin: 0 0 14px;
    font-size: 15px;
  }

  .mono {
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  /* 項目名と値の 2 列。長いパスや URL は折り返して全文を見せる（確認の目的なので省略しない）。 */
  .summary {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 14px;
    margin: 0 0 14px;
  }

  dt {
    color: var(--app-text-secondary);
  }

  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    flex: 0 0 auto;
    justify-content: flex-end;
    gap: var(--app-metric-gap);
  }

  .lower {
    flex: 1 1 auto;
    min-height: 0;
    margin-top: 14px;
    padding-top: 12px;
    overflow: auto;
    border-top: 1px solid var(--app-border-subtle);
  }

  .waiting {
    margin: 0;
    color: var(--app-text-muted);
  }

  .outcome {
    margin-top: 14px;
  }

  .heading {
    margin: 0 0 10px;
    font-size: 14px;
  }

  .heading.bad {
    color: var(--app-accent);
  }

  .hint {
    margin: 0 0 12px;
    padding: 8px 10px;
    background: var(--app-bg-raised);
    border-radius: var(--app-metric-radius);
  }

  .hint-title {
    margin: 0 0 4px;
    font-weight: 600;
  }

  .hint-body {
    margin: 0 0 6px;
    color: var(--app-text-secondary);
    overflow-wrap: anywhere;
  }

  .cmd-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0 0;
  }

  /*
   * 利用者が打つコマンド。長い refspec は折り返さず横に送る（途中で改行されると写し間違える）。
   * 押すと全体が選択されるので、コピーボタンが効かない環境でも選んで写せる。
   */
  .cmd {
    flex: 1 1 auto;
    min-width: 0;
    padding: 2px 6px;
    overflow-x: auto;
    white-space: pre;
    user-select: all;
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    color: var(--app-text-secondary);
    background: var(--app-bg-surface);
    border-radius: var(--app-metric-radius);
  }

  .copy {
    flex: 0 0 auto;
  }

  .log-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .note {
    margin: 0;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  summary {
    cursor: pointer;
    color: var(--app-text-secondary);
  }

  .log-text {
    max-height: 240px;
    margin: 6px 0 0;
    padding: 6px 8px;
    overflow: auto;
    white-space: pre;
    user-select: text;
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    background: var(--app-bg-raised);
    border-radius: var(--app-metric-radius);
  }
</style>
