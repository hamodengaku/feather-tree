<script lang="ts">
  /*
   * 「コミット&プッシュ」の確認（2026-09-30）。
   *
   * ConfirmDialog（決定 16、main が判定する不可逆操作の確認）とは別物にしてある。
   * プッシュは対応表で確認不要の操作で、これは利用者が一括実行を選んだときの
   * 念押しにすぎないため、main の確認の仕組みに載せない。「再表示しない」で切れ、
   * オプション > 環境タブで戻せる（設定 confirmCommitAndPush、アプリ全体で 1 つ）。
   */
  import { app } from '../lib/appState.svelte.js';

  let dontShowAgain = $state(false);

  $effect(() => {
    if (app.commitPushConfirmOpen) dontShowAgain = false;
  });
</script>

{#if app.commitPushConfirmOpen}
  <div class="backdrop" role="presentation" onclick={() => app.cancelCommitAndPush()}></div>
  <div class="dialog" role="alertdialog" aria-labelledby="commit-push-title" aria-describedby="commit-push-message">
    <h2 id="commit-push-title">コミット&プッシュ</h2>
    <p id="commit-push-message" class="warn">プッシュの取り消しは困難です！</p>
    <p>本当に一括実行しますか？</p>
    <label class="check">
      <input type="checkbox" bind:checked={dontShowAgain} />
      <span>再表示しない</span>
    </label>
    <div class="actions">
      <button onclick={() => app.cancelCommitAndPush()}>キャンセル</button>
      <button class="danger" onclick={() => void app.acceptCommitAndPush(dontShowAgain)}>実行する</button>
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

  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 12px;
    color: var(--app-text-secondary);
  }

  .check input {
    margin: 0;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--app-metric-gap);
    margin-top: 16px;
  }
</style>
