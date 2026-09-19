<script lang="ts">
  import { app } from '../lib/appState.svelte.js';
  import { THEME_OPTIONS } from '../lib/theme.js';
  import type { SettingsDto } from '@feathertree/ipc';

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  const { open, onclose }: Props = $props();

  function onThemeChange(e: Event): void {
    void app.setTheme((e.currentTarget as HTMLSelectElement).value as SettingsDto['theme']);
  }

  function onRefocusModeChange(e: Event): void {
    void app.setRefocusUpdateMode(
      (e.currentTarget as HTMLSelectElement).value as SettingsDto['refocusUpdateMode'],
    );
  }

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
  「不透明な板」= このダイアログ本体（.dialog、background: var(--app-bg-surface) で不透明）。
  半透明なのは背後の .backdrop だけ。ConfirmDialog.svelte と同じ作り。
  各設定は選択した時点で即時反映する（保存ボタンは無い。既存の setTheme と同じUX）。
-->
{#if open}
  <div class="backdrop" role="presentation" onclick={onclose}></div>
  <div class="dialog" role="dialog" aria-labelledby="options-title">
    <h2 id="options-title">設定</h2>

    <label class="field">
      <span>テーマ</span>
      <select value={app.settings?.theme} onchange={onThemeChange}>
        {#each THEME_OPTIONS as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>

    <label class="field">
      <span>ウィンドウ復帰時の更新</span>
      <select value={app.settings?.refocusUpdateMode} onchange={onRefocusModeChange}>
        <option value="auto">自動更新</option>
        <option value="modal">確認する</option>
        <option value="none">更新しない</option>
      </select>
    </label>

    <!--
      チェックボックスは label ごと押せるように input を中に入れる（for/id を振らない）。
      即時反映なので、押した瞬間にタブ段の見え方が変わる。
    -->
    <label class="check">
      <input
        type="checkbox"
        checked={app.settings?.tabShowCurrentInfo ?? true}
        onchange={(e) => void app.setTabShowCurrentInfo(e.currentTarget.checked)}
      />
      <span>レポジトリタブに現在情報を記載</span>
    </label>
    <p class="note">アクティブなタブに、ブランチ名と今のコミットの件名を並べます。</p>

    <!-- 更新（決定 29）。自動確認はしないが、新版の存在は通知する。ダウンロード・インストールはしない。 -->
    <div class="section">
      <h3 class="section-title">更新</h3>
      <p class="note version">現在のバージョン: {app.appInfo?.appVersion ?? '不明'}</p>

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

    <div class="actions">
      <button onclick={onclose}>閉じる</button>
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
    width: min(360px, 90vw);
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

  /* チェックボックスは横並び（.field の縦並びとは別物）。 */
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    color: var(--app-text-secondary);
  }

  .check input {
    flex: 0 0 auto;
    margin: 0;
  }

  /* 設定の効きを 1 行で補う。項目名より一段引いた見た目にする。 */
  .note {
    margin: 0 0 14px 22px;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  /* 節の区切り（更新）。上に区切り線を敷いて、テーマ系の設定と混ざらないようにする。 */
  .section {
    margin-top: 4px;
    padding-top: 12px;
    border-top: 1px solid var(--app-border-subtle);
  }

  .section-title {
    margin: 0 0 10px;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
    color: var(--app-text-secondary);
  }

  /* バージョン表示は note と同じ引き方だが、チェックボックスの上に来るので左マージンは付けない。 */
  .note.version {
    margin-left: 0;
  }

  .update-row {
    display: flex;
    align-items: center;
    gap: var(--app-metric-gap);
    margin: 8px 0;
  }

  .update-result {
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--app-metric-gap);
    margin-top: 6px;
  }
</style>
