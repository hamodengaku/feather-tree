<script lang="ts">
  /*
   * 起動時のスプラッシュ（決定 28）。
   *
   * **押せる要素を置かない。** 操作の口が無いのがスプラッシュで、ここで何かを選ばせると
   * 「起動を待つ画面」ではなくなる。銘もようこそ画面と違って出典は出さない（ただの文字）。
   */
  import AppIcon from './components/AppIcon.svelte';

  interface Props {
    /** main が app.getVersion() から渡した値。取れなければ空文字。 */
    version: string;
  }

  const { version }: Props = $props();
</script>

<div class="splash">
  <AppIcon size={128} />
  <div class="name">FeatherTree</div>
  {#if version.length > 0}
    <div class="version">{version}</div>
  {/if}
  <!-- 「巨人の肩の上に乗る矮人」。git とこのアプリが何の上に立っているかの銘 -->
  <div class="motto" lang="la">nani gigantum humeris insidentes</div>
</div>

<style>
  /*
   * ウィンドウいっぱいの板。寸法は main の SPLASH_WIDTH / SPLASH_HEIGHT で決まるので、
   * ここでは中身を中央に寄せることだけを受け持つ。
   *
   * 背景はテーマのアプリ地色。main 側も同じ色を backgroundColor に指定してあるので、
   * 中身が描かれる前も同じ色で、白いちらつきが起きない。
   */
  .splash {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    background-color: var(--app-bg-app);
    background-image: var(--app-bg-app-image);
    /* 枠なしウィンドウなので、アプリ自身で輪郭を描かないと地に溶ける */
    border: 1px solid var(--app-border-strong);
    box-sizing: border-box;
    /* テキスト選択の余地を与えない（掴めない板であることを見た目でも示す） */
    user-select: none;
    cursor: default;
  }

  .name {
    margin-top: 4px;
    color: var(--app-text-primary);
    font-size: 20px;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .version {
    margin-top: 2px;
    color: var(--app-text-muted);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  /* 銘。ようこそ画面の .motto と同じ扱い（斜体・一段引いた色）。 */
  .motto {
    margin-top: 14px;
    padding: 0 16px;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
    font-style: italic;
    letter-spacing: 0.02em;
    text-align: center;
  }
</style>
