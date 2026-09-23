<script lang="ts">
  /*
   * 縦帯。アプリヘッダより下、ペイン領域の左端に常に立っている細い帯（VS Code のそれ）。
   *
   * git を動かすものはここに置かない（それはツールバー段の左）。
   * 上端＝ペインの見せ方を変えるもの、下端＝アプリ全体の設定、という並びにする
   * （docs/01-architecture.md 8 章）。
   * ペインが畳まれていても消えないので、畳んだペインを呼び戻す口がここにある。
   *
   * 上端の内訳（決定 27 / 31）:
   *   1. 折り畳みボタン。**どのモードでもブランチペインが相手**
   *   2. モード切替の 4 ボタン（差分 / コミットログ / Stash 保存 / Stash 解放。排他）
   *
   * ブランチペインは 4 つのモードで共通（左に居続ける）。モードが変えるのは
   * その右側だけなので、折り畳みボタンの意味もモードで変わらない。
   *
   * 並びは「差分 → コミットログ → 区切り線 → Stash 保存 → Stash 解放」。
   * **既存 2 つの位置を動かさず**、新しい対を区切り線の下にまとめる
   * （stash の 2 つは互いに対なので隣り合わせる）。
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
  /** 新版があるとき、設定ボタンに小さなバッジを出す（決定 29）。 */
  const hasUpdate = $derived(app.hasUpdateAvailable);
  const settingsTitle = $derived(
    hasUpdate && app.updateState.version !== null
      ? `設定（新しいバージョン ${app.updateState.version} があります）`
      : '設定',
  );
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

    <hr class="rule" />

    <!--
      stash の 2 モード（決定 31）。箱を 2 つ置き、その間のアーチ矢印の向きだけで対を表す。
      左下の大きい箱が手前＝ワークツリー、右上の小さい箱が奥＝スタッシュ領域。
      箱と弧の形は 2 つで完全に同じにしてあり（矢じりの位置だけが違う）、
      「同じ経路を逆向きにたどる」ことが一目で分かるようにしている。
    -->
    <button
      class="activity-btn icon"
      class:active={mode === 'stash'}
      title="Stash 保存モード（ステージした差分だけを退避する）"
      aria-pressed={mode === 'stash'}
      onclick={() => void app.setViewMode('stash')}
    >
      <!-- 手前の箱から奥の箱へ。ワークツリーの差分をスタッシュ領域へ退避する -->
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <!-- 手前の箱（左下・大）と奥の箱（右上・小）。どちらも上辺の無い角ばった U 字 -->
        <path
          d="M2.5 12.5v8h11v-8M15 4v5h6.5V4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <!-- 手前の箱の中央から立ち上がり、奥の箱の左へ届く弧。矢じりは右向きの塗り三角で、弧は三角の底辺の中点で終わる -->
        <path
          d="M8 16.5Q8 6.5 10.6 6.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path d="M13.8 6.5L10.6 4v5z" fill="currentColor" />
      </svg>
    </button>
    <button
      class="activity-btn icon"
      class:active={mode === 'stash-list'}
      title="Stash 解放モード（退避した差分を見る・ブランチに展開する）"
      aria-pressed={mode === 'stash-list'}
      onclick={() => void app.setViewMode('stash-list')}
    >
      <!-- 同じ 2 つの箱で逆向き。スタッシュ領域からワークツリーへ差分を戻す -->
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path
          d="M2.5 12.5v8h11v-8M15 4v5h6.5V4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <!-- 保存モードと同じ弧を奥の箱の左から手前の箱の中央へ。矢じりは下向きの塗り三角で、弧は三角の底辺の中点で終わる -->
        <path
          d="M13.8 6.5Q8 6.5 8 14.3"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path d="M8 17.5L5.5 14.3h5z" fill="currentColor" />
      </svg>
    </button>

    <hr class="rule" />

    <!--
      Unity Prefab 差分モード（決定 32）。
      **Unity 公式のロゴは使わない**——代わりにヒエラルキーペインで
      ゲームオブジェクトに付けているのと同じ「立方体の等角投影」を描く。
    -->
    <button
      class="activity-btn icon"
      class:active={mode === 'unity'}
      title="Unity Prefab 差分モード（Prefab / シーンをコンポーネント単位で見る）"
      aria-pressed={mode === 'unity'}
      onclick={() => void app.enterUnityMode()}
    >
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <!--
          外形は正六角形（頂点が上下）。中心 (12,12)・外接円の半径 9 なので、
          横の頂点は 12 ± 9cos30° ≒ 12 ± 7.8、上下の頂点は 12 ± 9。
          中心から上左・上右・真下へ 3 本の稜線を引き、上面・左面・右面を見せる
          （UnityHierarchyPane の obj-icon と同じ形を 24 グリッドに合わせたもの）。
        -->
        <path
          d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
        <path
          d="M4.2 7.5L12 12l7.8-4.5M12 12v9"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>

  <!-- 下端。アプリ全体に効くものだけを置く。 -->
  <div class="group bottom">
    <button
      class="activity-btn small update-anchor"
      title={settingsTitle}
      aria-haspopup="dialog"
      aria-expanded={optionsOpen}
      onclick={onopenoptions}
    >
      {dark ? '☾' : '☀'}⚙
      {#if hasUpdate}
        <!-- 押せる的の面積は変えない。バッジは装飾で、確定情報は title と設定ダイアログ側にある。 -->
        <span class="update-badge" aria-hidden="true"></span>
      {/if}
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
    border-top: 4px solid var(--app-border-subtle);
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

  /* バッジを乗せる基準にするだけ。ボタンの見た目・的の面積は変えない。 */
  .update-anchor {
    position: relative;
  }

  /* 新版の通知（決定 29）。押せる面積を変えないよう絶対配置の装飾に留める。 */
  .update-badge {
    position: absolute;
    top: 2px;
    right: calc(50% - 12px);
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--app-accent);
    border: 1px solid var(--app-bg-raised);
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
