<script lang="ts">
  import { app } from '../lib/appState.svelte.js';
  import { joinPreview } from '../lib/cloneForm.js';

  async function run(): Promise<void> {
    const request = app.cloneConfirm;
    if (request === null || app.cloning) return;
    await app.cloneRepository(request, () => app.closeCloneDialog());
  }
</script>

<!--
  クローンの最終確認（対応表 #37 の実行前）。入力ダイアログ（CloneDialog）の「決定」で開く。
  入力の補完規則が込み入っているので、何がどこへ作られるかを実行前に見せる。
  決定 16 の破壊的操作の確認とは別物で、main は強制しない（renderer の中だけの確認）。

  実行する git コマンドはここに出さない。共通オプションなど見慣れない引数が並ぶと、
  一般の利用者が不安になるため。実行した内容はコマンドログに残る（決定 16 の透明性はそちらで担保）。

  実行もこのダイアログから行い、クローン中の進捗もここに出す。
  次のフェーズで、進捗表示をこのダイアログに広げる前提の置き場所にしてある（.progress の位置）。
-->
{#if app.cloneConfirm !== null}
  {@const request = app.cloneConfirm}
  <div class="backdrop" role="presentation" onclick={() => app.backToCloneForm()}></div>
  <div class="dialog" role="dialog" aria-labelledby="clone-confirm-title" aria-busy={app.cloning}>
    <h2 id="clone-confirm-title">クローンの確認</h2>

    <dl class="summary">
      <dt>URL</dt>
      <dd class="mono">{request.url}</dd>
      <!-- 保存先フォルダとフォルダ名は、つないだ「作成先」1 行で見せる（同じ情報を二重に並べない） -->
      <dt>作成先</dt>
      <dd class="mono">{joinPreview(request.parentDir, request.name)}</dd>
      <dt>シャロークローン</dt>
      <dd>{request.shallow ? 'する（最新コミットのみ取得）' : 'しない'}</dd>
    </dl>

    {#if app.cloning}
      <div class="progress" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span class="progress-line mono" title={app.cloneProgress ?? ''}>
          {app.cloneProgress ?? 'クローンを開始しています…'}
        </span>
      </div>
    {/if}

    <div class="actions">
      <button type="button" disabled={app.cloning} onclick={() => app.backToCloneForm()}>戻る</button>
      <button type="button" disabled={app.cloning || app.busy} onclick={() => void run()}>実行</button>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--app-layer-modal-backdrop);
    background: rgb(0 0 0 / 45%);
  }

  .dialog {
    position: fixed;
    z-index: var(--app-layer-modal);
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(520px, 90vw);
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

  .progress {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 6px;
    color: var(--app-text-muted);
  }

  .progress-line {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* タブの読み込み中の回転印（App.svelte の .tab-spinner）と同じ見え方。 */
  .spinner {
    flex: 0 0 auto;
    width: 10px;
    height: 10px;
    border: 2px solid var(--app-border-subtle);
    border-top-color: var(--app-accent);
    border-radius: 50%;
    animation: clone-spin 700ms linear infinite;
  }

  @keyframes clone-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: clone-spinner-pulse 1.2s ease-in-out infinite;
    }
  }

  @keyframes clone-spinner-pulse {
    50% {
      opacity: 0.25;
    }
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--app-metric-gap);
    margin-top: 6px;
  }
</style>
