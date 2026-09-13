<script lang="ts">
  /*
   * 「リポジトリを開く」のポップアップ。初期画面のボタンとタブ段の「＋」が共用する。
   * App.svelte の最上位に 1 つだけ置き、位置は押されたボタンが app.showOpenRepositoryMenu で渡す。
   */
  import { app } from '../lib/appState.svelte.js';
  import FileContextMenu from './FileContextMenu.svelte';
</script>

{#if app.openRepoMenu !== null}
  {@const open = app.openRepoMenu}
  <FileContextMenu
    x={open.x}
    y={open.y}
    onclose={() => app.closeOpenRepositoryMenu()}
    actions={[
      { label: 'ローカルのリポジトリを開く…', onclick: () => void app.openRepository() },
      { label: 'クローン…', onclick: () => app.openCloneDialog() },
    ]}
  />
{/if}
