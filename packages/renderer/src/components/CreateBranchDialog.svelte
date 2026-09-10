<script lang="ts">
  import { untrack } from 'svelte';
  import { app } from '../lib/appState.svelte.js';

  let source = $state('');
  let name = $state('');

  /**
   * 新しいブランチ名の仮入力。今いるブランチ名から最後の「/区切り」を 1 つ外したもの
   * （例: "obana/branch-pane" → "obana"）。区切りが無ければそのまま使う。
   */
  function dropLastSegment(branch: string): string {
    const slash = branch.lastIndexOf('/');
    return slash === -1 ? branch : branch.slice(0, slash);
  }

  /**
   * 開いた瞬間だけ「今いるブランチ」ベースの仮入力へ戻す。
   * currentBranch を untrack するのは、開いている最中に status が更新されても
   * 入力途中の内容を書き戻さないため。
   */
  $effect(() => {
    if (!app.createBranchOpen) return;
    const current = untrack(() => app.currentBranch) ?? '';
    source = current;
    name = dropLastSegment(current);
  });

  const canSubmit = $derived(!app.busy && source.trim().length > 0 && name.trim().length > 0);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    await app.createBranch(name.trim(), source.trim(), () => app.closeCreateBranch());
  }
</script>

<!--
  ブランチペインの「＋」から開く。作成は switch -c 1 回で「作成して切替」まで行い、push はしない
  （SessionOperations.createBranch 参照）。
  失敗時はグローバルなエラー表示（App.svelte の app.error）に任せ、ダイアログは閉じずに再入力させる。
-->
{#if app.createBranchOpen}
  <div class="backdrop" role="presentation" onclick={() => app.closeCreateBranch()}></div>
  <div class="dialog" role="dialog" aria-labelledby="create-branch-title">
    <h2 id="create-branch-title">新しいブランチを作成</h2>
    <form onsubmit={submit}>
      <label class="field">
        <span>ブランチ元</span>
        <input type="text" bind:value={source} spellcheck="false" autocomplete="off" />
      </label>

      <label class="field">
        <span>新しいブランチ名</span>
        <input type="text" bind:value={name} spellcheck="false" autocomplete="off" />
      </label>

      <div class="actions">
        <button type="button" onclick={() => app.closeCreateBranch()}>キャンセル</button>
        <button type="submit" disabled={!canSubmit}>作成</button>
      </div>
    </form>
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
    width: min(400px, 90vw);
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

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 14px;
    color: var(--app-text-secondary);
  }

  input {
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--app-metric-gap);
    margin-top: 6px;
  }
</style>
