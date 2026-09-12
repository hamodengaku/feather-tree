<script lang="ts">
  /*
   * 縦帯。アプリヘッダより下、ペイン領域の左端に常に立っている細い帯（VS Code のそれ）。
   *
   * git を動かすものはここに置かない（それはツールバー段の左）。
   * 上端＝ペインの見せ方を変えるもの、下端＝アプリ全体の設定、という並びにする
   * （docs/01-architecture.md 8 章）。
   * ペインが畳まれていても消えないので、畳んだペインを呼び戻す口がここにある。
   *
   * 上端の内訳（決定 27）:
   *   1. 折り畳みボタン。**どちらのモードでもブランチペインが相手**
   *   2. モード切替の 2 ボタン（差分モード / コミットログモード。排他）
   *
   * ブランチペインは 2 つのモードで共通（左に居続ける）。モードが変えるのは
   * その右側だけなので、折り畳みボタンの意味もモードで変わらない。
   */
  import { app } from '../lib/appState.svelte.js';
  import { isDarkTheme } from '../lib/theme.js';

  interface Props {
    /** 設定ダイアログが開いているか（aria-expanded 用）。 */
    optionsOpen: boolean;
    onopenoptions: () => void;
  }

  const { optionsOpen, onopenoptions }: Props = $props();

  const mode = $derived(app.viewMode);
  const collapsed = $derived(app.settings?.branchPaneCollapsed ?? false);
  const dark = $derived(isDarkTheme(app.settings?.theme ?? 'phoenix-light'));
</script>

<nav class="activity-bar" aria-label="表示と設定">
  <div class="group">
    <button
      class="activity-btn"
      title={collapsed ? 'ブランチペインを開く' : 'ブランチペインを閉じる'}
      aria-pressed={!collapsed}
      onclick={() => void app.setBranchPaneCollapsed(!collapsed)}
    >
      {collapsed ? '›' : '‹'}
    </button>

    <hr class="rule" />

    <!--
      モード切替。押した側だけが押し込まれた見た目になる（ラジオボタンと同じ排他）。
      ここだけインライン SVG なのは、記号 1 文字では「差分」と「履歴」を描き分けられないため
      （docs/01-architecture.md 8 章「アイコンは SVG をインライン」）。
    -->
    <button
      class="activity-btn icon"
      class:active={mode === 'diff'}
      title="差分モード（作業ツリーの変更を見る）"
      aria-pressed={mode === 'diff'}
      onclick={() => void app.setViewMode('diff')}
    >
      <!-- 書類に + と − 。作業ツリーの差分を表す -->
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path
          d="M6 2.5h8l4.5 4.5v14.5H6z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
        <path d="M14 2.5V7h4.5" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path d="M8.5 12h7M8.5 16.5h7M12 9v6" fill="none" stroke="currentColor" stroke-width="1.6" />
      </svg>
    </button>
    <button
      class="activity-btn icon"
      class:active={mode === 'log'}
      title="コミットログモード（履歴とコミットの詳細を見る）"
      aria-pressed={mode === 'log'}
      onclick={() => void app.setViewMode('log')}
    >
      <!-- 幹から枝が出て戻るグラフ。コミットログのレーンそのもの -->
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path
          d="M8 4.5v15M8 8.5c0 3 8 2 8 5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
        <circle cx="8" cy="5.5" r="2.1" fill="none" stroke="currentColor" stroke-width="1.6" />
        <circle cx="8" cy="18.5" r="2.1" fill="none" stroke="currentColor" stroke-width="1.6" />
        <circle cx="16" cy="14.5" r="2.1" fill="none" stroke="currentColor" stroke-width="1.6" />
      </svg>
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

  /* ペイン操作（上）とモード切替（下）を見た目で切り離す。 */
  .rule {
    width: 60%;
    margin: 3px auto;
    border: none;
    border-top: 1px solid var(--app-border-subtle);
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

  /* SVG を入れるものは中央に置く（文字の行送りに引きずられないように）。 */
  .activity-btn.icon {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 5px 0;
  }

  /*
    選択中のモード。押し込みではなく「左端の縦線 + 濃い文字色」で示す（VS Code と同じ形）。
    帯の幅が狭く、背景を塗ると隣のボタンとの境が消えるため。
  */
  .activity-btn.active {
    color: var(--app-text-primary);
    box-shadow: inset 2px 0 0 var(--app-accent);
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
