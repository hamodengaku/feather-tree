<script lang="ts">
  /*
   * Stash 保存モードの、作業ツリーペイン下端の箱（決定 31）。
   *
   * 差分モードのコミット欄と**同じ場所・同じ形**に座る。入れ替わるのはここだけで、
   * 上のファイル一覧も右の差分ペインもそのまま（同じ実体を使い続ける）。
   * 「ステージしてから下の箱で確定する」という手順が 2 つのモードで揃うので、
   * 覚え直すことが無い。
   *
   * **保存されるのはステージ済みだけ**（`git stash push --staged`）。これはコミットと
   * まったく同じ選び方なので、文言でもそう言う——「全部どける」ピュアな stash を
   * 期待した人が、未ステージの変更が残っているのを見て驚かないようにする。
   */
  import { app } from '../lib/appState.svelte.js';

  const stagedCount = $derived(app.summary?.counts.staged ?? 0);
  /** 退避しても残るもの。数えておくと「消えた」と誤解されにくい。 */
  const remainingCount = $derived(app.changes.total);

  /**
   * 保存できない理由。ボタンを灰色にするだけでは何が足りないか分からないので、
   * 1 行で出す（足りているときは null で、その行ごと出さない）。
   */
  const blockedReason = $derived.by(() => {
    if (!app.canUseStagedStash) {
      return 'この git では使えません（git 2.35 以降が必要です）。';
    }
    if (stagedCount === 0) return '退避したい変更をステージしてください。';
    if (app.stashMessage.trim().length === 0) return 'メッセージを入力してください。';
    return null;
  });
</script>

<section class="stash-save">
  <textarea
    bind:value={app.stashMessage}
    placeholder="stash のメッセージ（後で一覧から探す手がかりになります）"
    rows="4"
    spellcheck="false"
    disabled={!app.canUseStagedStash}
  ></textarea>

  <p class="note">
    ステージ済みの <strong>{stagedCount}</strong> 件だけを退避します（未追跡ファイルも、ステージしてあれば入ります）。
    {#if remainingCount > 0}
      未ステージの <strong>{remainingCount}</strong> 件は作業ツリーに残ります。
    {/if}
  </p>

  <div class="actions">
    <span class="reason">{blockedReason ?? ''}</span>
    <button disabled={!app.canSaveStash} onclick={() => void app.saveStash()}>stash に保存</button>
  </div>
</section>

<style>
  .stash-save {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    background: var(--app-bg-surface);
  }

  .stash-save textarea {
    resize: vertical;
    min-height: 60px;
  }

  .note {
    margin: 0;
    color: var(--app-text-secondary);
    font-size: var(--app-font-size-mono);
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-metric-gap);
  }

  /* 押せない理由。ボタンの左に置き、長ければ端から隠す（ボタンの幅は動かさない）。 */
  .reason {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }
</style>
