<script lang="ts">
  import { app } from '../lib/appState.svelte.js';
  import OptionsEnvironmentTab from './OptionsEnvironmentTab.svelte';
  import OptionsGitTab from './OptionsGitTab.svelte';
  import OptionsSshTab from './OptionsSshTab.svelte';
  import OptionsFeatherTreeTab from './OptionsFeatherTreeTab.svelte';

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  const { open, onclose }: Props = $props();

  type OptionsTab = 'env' | 'git' | 'ssh' | 'app';

  const TABS: readonly { id: OptionsTab; label: string }[] = [
    { id: 'env', label: '環境' },
    { id: 'git', label: 'Git' },
    { id: 'ssh', label: 'ssh通信' },
    { id: 'app', label: 'FeatherTree' },
  ];

  /*
   * 選択中のタブ。設定には保存しない。
   * {#if open} が包むのはマークアップだけなので、閉じて開き直すと前回のタブに戻る
   * （設定を続けて直す使い方が多いので、毎回「環境」に戻るより手数が少ない）。
   */
  let tab = $state<OptionsTab>('env');

  let tabButtons = $state<HTMLButtonElement[]>([]);

  /** 押されたキーが移動先の位置を指すなら、その位置。関係ないキーなら null。 */
  function targetIndex(key: string, index: number): number | null {
    const last = TABS.length - 1;
    if (key === 'ArrowRight') return index === last ? 0 : index + 1;
    if (key === 'ArrowLeft') return index === 0 ? last : index - 1;
    if (key === 'Home') return 0;
    if (key === 'End') return last;
    return null;
  }

  /*
   * tablist の作法（roving tabindex）。選択中のタブだけが Tab キーの止まり場になり、
   * 左右キーでタブを移る。ダイアログはキーボードの逃げ場が無いので、
   * CommitDetailPane のタブ段より一段丁寧にしてある。
   *
   * 待ち受けるのは tablist ではなくタブ自身。焦点は必ずタブの上にあるので用は足り、
   * 「interactive role を持つ要素には tabindex が要る」を器側で背負わずに済む。
   */
  function onTabKeydown(e: KeyboardEvent, index: number): void {
    const next = targetIndex(e.key, index);
    if (next === null) return;
    const target = TABS[next];
    if (target === undefined) return;

    e.preventDefault();
    tab = target.id;
    tabButtons[next]?.focus();
  }
</script>

<!--
  「不透明な板」= このダイアログ本体（.dialog、background: var(--app-bg-surface) で不透明）。
  半透明なのは背後の .backdrop だけ。ConfirmDialog.svelte と同じ作り。

  設定は選んだ時点で即時反映する（保存ボタンは無い）。
  **唯一の例外が Git タブのコミット情報**で、あれはユーザーの .git/config を書き換えるため
  明示の保存ボタンを置いてある（決定 13 の追記、「やらないこと」の明示ボタン例外）。
-->
{#if open}
  <div class="backdrop" role="presentation" onclick={onclose}></div>
  <div class="dialog" role="dialog" aria-labelledby="options-title">
    <h2 id="options-title">設定</h2>

    <div class="tabs" role="tablist" aria-label="設定の分類">
      {#each TABS as t, i (t.id)}
        <button
          bind:this={tabButtons[i]}
          role="tab"
          id={'options-tab-' + t.id}
          aria-controls={'options-panel-' + t.id}
          aria-selected={tab === t.id}
          tabindex={tab === t.id ? 0 : -1}
          class:active={tab === t.id}
          title={t.id === 'app' && app.hasUpdateAvailable ? '新しいバージョンがあります' : undefined}
          onclick={() => (tab = t.id)}
          onkeydown={(e) => onTabKeydown(e, i)}
        >
          {t.label}
          <!--
            更新の通知（決定 29）が FeatherTree タブの奥に入るので、縦帯のバッジから
            ここまで辿れるようにする。ActivityBar のバッジと同じく装飾に留め、
            確定情報は title とタブの中に置く。
          -->
          {#if t.id === 'app' && app.hasUpdateAvailable}
            <span class="badge" aria-hidden="true"></span>
          {/if}
        </button>
      {/each}
    </div>

    <!--
      パネルは高さ固定の .dialog の中で唯一伸び縮みする要素。
      tabindex="0" はキーボードだけで中身をスクロールできるようにするため。
    -->
    <div
      class="panel"
      role="tabpanel"
      id={'options-panel-' + tab}
      aria-labelledby={'options-tab-' + tab}
      tabindex="0"
    >
      {#if tab === 'env'}
        <OptionsEnvironmentTab />
      {:else if tab === 'git'}
        <OptionsGitTab />
      {:else if tab === 'ssh'}
        <OptionsSshTab />
      {:else}
        <OptionsFeatherTreeTab />
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

  /*
    高さは max-height ではなく height で固定する。
    タブごとに中身の量が違うので、伸縮を許すと切り替えるたびに枠が跳ねて読みにくい。
  */
  .dialog {
    position: fixed;
    z-index: var(--app-layer-modal);
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    width: min(720px, 92vw);
    height: min(760px, 88vh);
    padding: 18px 20px;
    background: var(--app-bg-surface);
    border: 1px solid var(--app-border-strong);
    border-radius: var(--app-metric-radius);
    box-shadow: 0 8px 32px rgb(0 0 0 / 40%);
  }

  h2 {
    flex: 0 0 auto;
    margin: 0 0 12px;
    font-size: 15px;
  }

  /* タブ段は中央寄せ。CommitDetailPane のタブ段と同じ見た目にする。 */
  .tabs {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
    border-bottom: 1px solid var(--app-border-subtle);
  }

  .tabs button {
    background: none;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: var(--app-metric-radius) var(--app-metric-radius) 0 0;
    padding: 4px 18px;
    color: var(--app-text-secondary);
  }

  .tabs button:hover:not(.active) {
    background: var(--app-bg-hover);
  }

  .tabs button.active {
    background: var(--app-bg-app);
    border-color: var(--app-border-subtle);
    color: var(--app-text-primary);
    font-weight: 600;
  }

  .badge {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-left: 5px;
    vertical-align: middle;
    border-radius: 50%;
    background: var(--app-accent);
  }

  /* min-height: 0 が無いと flex の子が縮まず、はみ出してもスクロールバーが出ない。 */
  .panel {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 2px 0;
  }

  .actions {
    display: flex;
    flex: 0 0 auto;
    justify-content: flex-end;
    gap: var(--app-metric-gap);
    padding-top: 12px;
  }
</style>
