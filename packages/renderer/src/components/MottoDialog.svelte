<script lang="ts">
  interface Props {
    open: boolean;
    onclose: () => void;
  }

  const { open, onclose }: Props = $props();
</script>

<!--
  ようこそ画面の銘（nani gigantum humeris insidentes）の出典を見せるだけのダイアログ。
  遊びなので操作は無い。**どこを押しても閉じるだけ**で、状態は何も変わらない。

  作りは ConfirmDialog / OptionsDialog と同じ（半透明の backdrop + 不透明な板）。
  重なり順は tokens.css の --app-layer-modal-* で決まる。
-->
{#if open}
  <div class="backdrop" role="presentation" onclick={onclose}></div>
  <!--
    板そのものも閉じる当たり判定にする（決定は無く、閉じる以外の行き先が無いため）。
    キーボードからは Esc でも Enter/Space でも閉じられるようにしてある。
  -->
  <div
    class="dialog"
    role="dialog"
    aria-labelledby="motto-quote"
    tabindex="-1"
    onclick={onclose}
    onkeydown={(event) => {
      if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') onclose();
    }}
  >
    <blockquote id="motto-quote" lang="la">
      Dicebat Bernardus Carnotensis nos esse quasi nanos, gigantum humeris insidentes, ut possimus
      plura eis et remotiora videre, non utique proprii visus acumine, aut eminentia corporis, sed
      quia in altum subvehimur et extollimur magnitudine gigantea.
    </blockquote>
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
    padding: 22px 26px;
    background: var(--app-bg-surface);
    border: 1px solid var(--app-border-strong);
    border-radius: var(--app-metric-radius);
    box-shadow: 0 8px 32px rgb(0 0 0 / 40%);
    /* 閉じる以外にできることが無いので、板の上でもクリックを促す形にしておく。 */
    cursor: pointer;
  }

  .dialog:focus-visible {
    outline: 1px solid var(--app-accent);
    outline-offset: -1px;
  }

  blockquote {
    margin: 0;
    padding-left: 14px;
    border-left: 2px solid var(--app-accent);
    color: var(--app-text-secondary);
    font-style: italic;
    line-height: 1.8;
  }
</style>
