<script lang="ts">
  /*
   * 縦帯。アプリヘッダより下、ペイン領域の左端に常に立っている細い帯（VS Code のそれ）。
   *
   * git を動かすものはここに置かない（それはツールバー段の左）。
   * 上端＝ペインの見せ方を変えるもの、下端＝アプリ全体の設定、という並びにする
   * （docs/01-architecture.md 8 章）。
   * ペインが畳まれていても消えないので、畳んだペインを呼び戻す口がここにある。
   */
  import { app } from '../lib/appState.svelte.js';
  import { isDarkTheme } from '../lib/theme.js';

  interface Props {
    /** 設定ダイアログが開いているか（aria-expanded 用）。 */
    optionsOpen: boolean;
    onopenoptions: () => void;
  }

  const { optionsOpen, onopenoptions }: Props = $props();

  const branchCollapsed = $derived(app.settings?.branchPaneCollapsed ?? false);
  const dark = $derived(isDarkTheme(app.settings?.theme ?? 'phoenix-light'));
</script>

<nav class="activity-bar" aria-label="表示と設定">
  <div class="group">
    <button
      class="activity-btn"
      title={branchCollapsed ? 'ブランチペインを開く' : 'ブランチペインを閉じる'}
      aria-pressed={!branchCollapsed}
      onclick={() => void app.setBranchPaneCollapsed(!branchCollapsed)}
    >
      {branchCollapsed ? '›' : '‹'}
    </button>
  </div>

  <!-- 下端。アプリ全体に効くものだけを置く。 -->
  <div class="group bottom">
    <button
      class="activity-btn small"
      title="設定"
      aria-haspopup="dialog"
      aria-expanded={optionsOpen}
      onclick={onopenoptions}
    >
      {dark ? '☾' : '☀'}⚙
    </button>
  </div>
</nav>

<style>
  .activity-bar {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    width: var(--app-metric-activitybar-width);
    background: var(--app-bg-raised);
    border-right: 1px solid var(--app-border-subtle);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 0;
  }

  /* 上の組との間を全部食わせて、下端に貼り付ける。 */
  .bottom {
    margin-top: auto;
  }

  .activity-btn {
    flex: 0 0 auto;
    width: 100%;
    padding: 4px 0;
    background: none;
    border: none;
    border-radius: 0;
    color: var(--app-text-secondary);
    /* 記号 1 文字だけなので、本文と同じ大きさでは細すぎて的が見えない。 */
    font-size: calc(var(--app-font-size-ui) * 2);
    line-height: 1;
  }

  /* 2 文字入るものは、帯の幅に収まるまで落とす。 */
  .activity-btn.small {
    font-size: calc(var(--app-font-size-ui) * 1.2);
    line-height: 1.4;
  }

  .activity-btn:hover {
    color: var(--app-text-primary);
    background: var(--app-bg-hover);
  }

  .activity-btn:focus-visible {
    outline: 1px solid var(--app-accent);
    outline-offset: -1px;
  }
</style>
