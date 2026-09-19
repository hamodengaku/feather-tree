<script lang="ts">
  import { app } from '../lib/appState.svelte.js';
  import AppIcon from './AppIcon.svelte';

  /*
   * 更新確認の結果文言（決定 29）。
   * 確認中は結果欄を空にする（「今すぐ確認」ボタン側の文字で分かるので二重に出さない）。
   */
  const updateResultText = $derived.by((): string => {
    if (app.checkingUpdate) return '';
    if (app.updateState.outcome === 'new-version') {
      return `新しいバージョン ${app.updateState.version ?? ''} があります`;
    }
    if (app.updateState.outcome === 'up-to-date') return '最新です';
    if (app.updateState.outcome === 'failed') return '確認できませんでした';
    return ''; // 'unknown'（まだ 1 度も確認していない）
  });
</script>

<!--
  このアプリ自身のこと（銘板と更新）。決定 29 のとおり、
  新版の存在は通知するが、ダウンロードもインストールもしない。

  中央揃えにするのは銘板だけ。更新は他のタブと同じ左寄せの設定の束なので、
  ここだけ中央に寄せると読む起点が揃わなくなる。
-->
<div class="tab">
  <div class="plate">
    <AppIcon size={64} />
    <h1>FeatherTree</h1>
    <p class="note">バージョン {app.appInfo?.appVersion ?? '不明'}</p>
  </div>

  <div class="block">
    <h3 class="block-title">更新</h3>

    <label class="check">
      <input
        type="checkbox"
        checked={app.settings?.checkForUpdates ?? true}
        onchange={(e) => void app.setCheckForUpdates(e.currentTarget.checked)}
      />
      <span>起動時に自動で確認する（24 時間に 1 回）</span>
    </label>

    <div class="update-row">
      <button onclick={() => void app.checkForUpdatesNow()} disabled={app.checkingUpdate}>
        {app.checkingUpdate ? '確認中…' : '今すぐ確認'}
      </button>
      {#if updateResultText.length > 0}
        <span class="update-result">{updateResultText}</span>
      {/if}
    </div>

    {#if app.hasUpdateAvailable}
      <div class="update-row">
        <button onclick={() => void app.openUpdateReleasePage()}>ダウンロードページを開く</button>
        <button onclick={() => void app.dismissUpdate()}>この版は通知しない</button>
      </div>
    {/if}
  </div>
</div>

<style>
  /*
    銘板を上、更新を下端に置く。パネルの高さいっぱいに広げてから、更新の側に
    margin-top: auto を与えて押し下げる。

    min-height（height ではなく）にしてあるのは、中身がパネルより高くなったときに
    はみ出さず伸びるようにするため。box-sizing: border-box が全体に効いているので、
    100% はパネルの内容領域＝パディングを除いた高さに解決する（＝常時スクロールバーが
    出るようなことにはならない）。
  */
  .tab {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }

  /*
    銘板。リポジトリを 1 つも開いていないときの画面（App.svelte の .notice）と
    同じ見え方にする——同じアプリの同じ名乗りが 2 通りあると落ち着かないため。
    **中央揃えはここだけ。** 座布団は敷かない（設定の束ではなく、このタブの顔なので）。
  */
  .plate {
    text-align: center;
    margin-bottom: 18px;
  }

  .plate h1 {
    margin: 0 0 6px;
    font-size: 20px;
  }

  .note {
    margin: 0;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  /*
    座布団は環境タブ・Git タブと同じ（線ではなく面でまとまりを示す）。
    margin-top: auto が、銘板との間の余りを全部吸ってこのブロックを下端へ送る。
    中身は他のタブと同じ左寄せ。
  */
  .block {
    margin-top: auto;
    padding: 10px 12px;
    border-radius: var(--app-metric-radius);
    background: var(--app-bg-raised);
  }

  .block-title {
    margin: 0 0 8px;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
    color: var(--app-text-secondary);
  }

  /* 他のタブのチェックボックスと同じ（label ごと押せる横並び）。 */
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--app-text-secondary);
  }

  .check input {
    flex: 0 0 auto;
    margin: 0;
  }

  .update-row {
    display: flex;
    align-items: center;
    gap: var(--app-metric-gap);
    margin: 8px 0;
  }

  .update-row:last-child {
    margin-bottom: 0;
  }

  .update-result {
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }
</style>
