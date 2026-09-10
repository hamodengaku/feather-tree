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

    <div class="actions">
      <button onclick={onclose}>閉じる</button>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 45%);
  }

  .dialog {
    position: fixed;
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

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--app-metric-gap);
    margin-top: 6px;
  }
</style>
