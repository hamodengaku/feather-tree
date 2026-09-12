<script lang="ts">
  /*
   * コマンドバー（決定 26）。ツールバー段の余剰幅すべてを占める帯。
   *
   * 時間で役目が変わる。
   *   実行中: 走っている git コマンド名を映す（押せない）
   *   待機中: リポジトリを外部ターミナルで開く口になる
   *
   * 同じ場所を取り合うので、両立させずに切り替える。
   * 実行中に出す文字はコマンドログと同じラベル（`git status` など）で、進捗の中身
   * （Receiving objects: 45%）は出さない。それは未実装（docs/01-architecture.md 6 章）。
   */
  import { expoOut } from 'svelte/easing';
  import { fade, fly } from 'svelte/transition';
  import { app } from '../lib/appState.svelte.js';

  /*
   * 所要時間と曲線。tokens.css に置けないのは、Svelte の transition が
   * CSS 変数ではなく数値を取るため。
   *
   * 120ms 以下は「動いた」ではなく「切り替わった」と受け取られるので、
   * ふわっと見せるには 200ms 前後が要る。ただし git の大半は数十 ms で終わるため、
   * 素直に伸ばすと短命なコマンドが薄いまま消える。
   *
   * そこで **expoOut**（最初に一気に立ち上がり、末尾が長く伸びる曲線）を使う。
   * 60ms 時点の不透明度が cubicOut の 61% に対し 85% まで上がるので、
   * 短いコマンドはほぼ見えたまま、長いコマンドだけがゆっくり落ち着く。
   */
  const IN_MS = 220;
  const OUT_MS = 140;

  const running = $derived(app.runningCommand);
</script>

<div class="command-bar">
  {#if running !== null}
    <!--
      演出は「現れるとき」だけ。実行中から実行中への切り替わりでは要素を作り直さず、
      中の文字だけを差し替える（opId で key を張らない）。

      1 操作で git は最大 3 個連続する（タブを開く = status → for-each-ref → remote）。
      読み取り系は数十 ms なので 3 個が 200ms ほどに密集する。作り直すと
      「前が消える 140ms」と「次が出る 220ms」が重なり、別々の文字列が同じ場所で
      二重に見えてしまう。連続実行の 2 個目以降は「表示」ではなく「更新」なので、
      演出の対象から外す。
    -->
    <div class="running" in:fly={{ y: 6, duration: IN_MS, easing: expoOut }} out:fade={{ duration: OUT_MS }}>
      git {running.args.join(' ')}
    </div>
  {:else}
    <!--
      消えるのを待ってから出す。同じマスを共有しているので、遅らせないと
      消えかけのコマンド名と重なって濁る。
    -->
    <button
      class="idle"
      disabled={app.activeId === null}
      title="このリポジトリをターミナルで開く"
      in:fade={{ duration: OUT_MS, delay: OUT_MS }}
      onclick={() => void app.openTerminal()}
    >
      ターミナルで開く
    </button>
  {/if}
</div>

<style>
  .command-bar {
    /* ツールバー段の左右のボタン群に挟まれ、残りの幅を全部取る。 */
    flex: 1 1 auto;
    min-width: 0;
    /* 中身が入れ替わる間も高さが動かないよう、器の側で高さを決める。 */
    display: grid;
    height: 24px;
    overflow: hidden;
    background: var(--app-bg-app);
    border: 1px solid var(--app-border-subtle);
    border-radius: var(--app-metric-radius);
  }

  /*
   * 実行中の表示と待機中のボタンを同じマスに重ねる。
   * out トランジションの最中は 2 つが同時に存在するので、並べると横にずれる。
   */
  .running,
  .idle {
    grid-area: 1 / 1;
    display: flex;
    align-items: center;
    min-width: 0;
    padding: 0 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .running {
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    color: var(--app-text-secondary);
  }

  .idle {
    background: none;
    border: none;
    border-radius: 0;
    color: var(--app-text-muted);
    text-align: left;
  }

  .idle:hover:not(:disabled) {
    background: var(--app-bg-hover);
    color: var(--app-text-secondary);
  }

  .idle:focus-visible {
    outline: 1px solid var(--app-accent);
    outline-offset: -1px;
  }
</style>
