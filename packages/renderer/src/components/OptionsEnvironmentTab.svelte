<script lang="ts">
  import { app } from '../lib/appState.svelte.js';
  import { THEME_OPTIONS } from '../lib/theme.js';
  import type { SettingsDto } from '@feathertree/ipc';

  /** ウィンドウ復帰時の更新（決定 14 の唯一の自動入口）。勝手に動く → 訊いてくる → 何もしない。 */
  const REFOCUS_OPTIONS: readonly { value: SettingsDto['refocusUpdateMode']; label: string }[] = [
    { value: 'auto', label: '自動更新' },
    { value: 'modal', label: '確認する' },
    { value: 'none', label: '更新しない' },
  ];
</script>

<!-- 各設定は選択した時点で即時反映する（保存ボタンは無い。既存の setTheme と同じUX）。 -->
<!--
  選択肢は畳まずに並べる（プルダウンではなくラジオ）。
  どちらも候補が 3〜4 個しかなく、開かなくても全部見えるほうが選びやすい。
  チェックボックスと同じく label ごと押せるように input を中に入れる（for/id を振らない）。
-->
<fieldset class="group">
  <legend>テーマ</legend>
  <!-- ダーク／ライト × クラシック／フェザーの 2 軸なので、2 列に並べると対応が見て取れる。 -->
  <div class="grid">
    {#each THEME_OPTIONS as option (option.value)}
      <label class="radio">
        <input
          type="radio"
          name="options-theme"
          checked={app.settings?.theme === option.value}
          onchange={() => void app.setTheme(option.value)}
        />
        <span>{option.label}</span>
      </label>
    {/each}
  </div>
</fieldset>

<fieldset class="group">
  <legend>ウィンドウ復帰時の更新</legend>
  {#each REFOCUS_OPTIONS as option (option.value)}
    <label class="radio">
      <input
        type="radio"
        name="options-refocus"
        checked={app.settings?.refocusUpdateMode === option.value}
        onchange={() => void app.setRefocusUpdateMode(option.value)}
      />
      <span>{option.label}</span>
    </label>
  {/each}
</fieldset>

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

<style>
  /*
    ラジオの束を、ごく薄い座布団に載せてひとまとまりに見せる。

    fieldset の既定の枠線は落とし、**線ではなく面**でまとまりを示す
    （項目が増えるたびに罫線が増えると、画面が表組みのように見えて読みにくくなる）。
    色は raised トークンなので、どのテーマでも「ダイアログの面から一段持ち上がる」
    関係が保たれる（明るい／暗いを自前で計算しない）。
  */
  .group {
    margin: 0 0 14px;
    padding: 10px 12px;
    border: none;
    border-radius: var(--app-metric-radius);
    background: var(--app-bg-raised);
  }

  .group legend {
    /* legend は既定で左右に余白を持つ。座布団の縁と文字の頭を揃えるために消す。 */
    padding: 0;
    margin-bottom: 8px;
    color: var(--app-text-secondary);
  }

  .radio {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    color: var(--app-text-secondary);
  }

  .radio input {
    flex: 0 0 auto;
    margin: 0;
  }

  /*
    テーマは 2 列。**列の向きに流す**ので、THEME_OPTIONS の並び（フェザー 2 つ →
    クラシック 2 つ）がそのまま「左列＝フェザー / 右列＝クラシック」になる。
    行に流すと系統が横に割れてしまう。

    列幅を max-content にすると label の押せる幅がラベル文字の分だけになり、
    行ごとに幅が揃わない。1fr の 2 等分にして、どの行も同じ幅の的にする。
  */
  .grid {
    display: grid;
    grid-template-rows: auto auto;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    column-gap: var(--app-metric-gap);
    row-gap: 4px;
  }

  /*
    座布団を敷いたので、束の下端に余分な余白を残さない
    （残すと上下の padding が非対称に見えて、座布団が下にずれて見える）。
    2 列側は行間を row-gap が持つので、項目の margin は落とす。
  */
  .grid .radio,
  .group > .radio:last-child {
    margin-bottom: 0;
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

  /* 更新（決定 29）は「FeatherTree」タブへ移した（OptionsFeatherTreeTab.svelte）。 */
</style>
