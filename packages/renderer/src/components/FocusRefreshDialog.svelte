<script lang="ts">
  import { app } from '../lib/appState.svelte.js';

  const visible = $derived(
    app.focusRefreshPrompt !== null && app.focusRefreshPrompt.sessionId === app.activeId,
  );
</script>

<!--
  refocusUpdateMode が 'modal' のときだけ、ウィンドウ復帰時に main から送られてくる通知を受けて表示する。
  タブ切替後に古い通知が別タブに対して出ないよう、activeId と一致する場合だけ表示する。
  見た目は ConfirmDialog.svelte と同じ backdrop+dialog の作り。
-->
{#if visible}
  <div class="backdrop" role="presentation" onclick={() => app.dismissFocusRefreshPrompt()}></div>
  <div class="dialog" role="alertdialog" aria-labelledby="focus-refresh-title">
    <h2 id="focus-refresh-title">更新の確認</h2>
    <p>ウィンドウがアクティブになりました。最新の状態に更新しますか？</p>
    <div class="actions">
      <button onclick={() => app.dismissFocusRefreshPrompt()}>しない</button>
      <button onclick={() => void app.acceptFocusRefreshPrompt()}>更新</button>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 45%);
  }

  .dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(440px, 90vw);
    padding: 18px 20px;
    background: var(--app-bg-surface);
    border: 1px solid var(--app-border-strong);
    border-radius: var(--app-metric-radius);
    box-shadow: 0 8px 32px rgb(0 0 0 / 40%);
  }

  h2 {
    margin: 0 0 10px;
    font-size: 15px;
  }

  p {
    margin: 0 0 8px;
    color: var(--app-text-secondary);
    line-height: 1.6;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--app-metric-gap);
    margin-top: 16px;
  }
</style>
