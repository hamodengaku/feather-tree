<script lang="ts">
  import { app } from '../lib/appState.svelte.js';

  const pending = $derived(app.pendingConfirmation);
</script>

<!--
  確認の判定は main 側が行う。renderer は 'needs-confirmation' で拒否された内容を
  そのまま表示するだけ（docs/00-decisions.md 決定 16）。
-->
{#if pending !== null}
  <div class="backdrop" role="presentation" onclick={() => app.cancelConfirmation()}></div>
  <div class="dialog" role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-message">
    <h2 id="confirm-title">{pending.confirmation.title}</h2>
    <p id="confirm-message">{pending.confirmation.message}</p>
    {#if !pending.confirmation.recoverable}
      <p class="warn">この操作は取り消せません。</p>
    {/if}
    <div class="actions">
      <button onclick={() => app.cancelConfirmation()}>キャンセル</button>
      {#if pending.secondary}
        {@const secondary = pending.secondary}
        <button
          onclick={() => {
            secondary.onClick();
            app.cancelConfirmation();
          }}
        >
          {secondary.label}
        </button>
      {/if}
      <button class="danger" onclick={() => void app.acceptConfirmation()}>
        {pending.confirmation.confirmLabel}
      </button>
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

  .warn {
    color: var(--app-text-danger);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--app-metric-gap);
    margin-top: 16px;
  }
</style>
