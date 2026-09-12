<script lang="ts">
  /*
   * ツールバー段の左に並ぶリモート操作（対応表 #22〜#25）。
   *
   * フェッチだけは行き先が 1 つに決まることが多いので、決まるなら即実行する。
   * プッシュは選ぶものが多い（ブランチ・リモート・上流の設定）ためダイアログに任せる。
   * 確認ダイアログはどれにも要らない。確認が要るのは強制プッシュだけで、それは未実装（決定 16）。
   */
  import { app } from '../lib/appState.svelte.js';
  import FileContextMenu from './FileContextMenu.svelte';

  /** フェッチ先を選ばせているときの位置。null なら出していない。 */
  let fetchMenu = $state<{ x: number; y: number } | null>(null);

  /*
   * リモートが 1 つも無いリポジトリでは 3 つとも成立しない。
   * 押せるのに必ず失敗する状態を作らず、理由をツールチップで言う。
   */
  const noRemote = $derived(app.remotes.length === 0);
  const disabled = $derived(app.busy || app.activeId === null || noRemote);

  function handleFetch(event: MouseEvent): void {
    const remotes = app.remotes;
    // リモートが 1 つなら選ばせる意味が無い。押した瞬間に取りに行く。
    if (remotes.length === 1 && remotes[0] !== undefined) {
      void app.fetch(remotes[0]);
      return;
    }
    // メニューはボタンの真下から出す。右クリックと違いカーソル位置には出さない。
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    fetchMenu = { x: Math.round(rect.left), y: Math.round(rect.bottom + 2) };
  }
</script>

<button
  {disabled}
  title={noRemote ? 'リモートが設定されていません' : 'リモートから取得する'}
  onclick={handleFetch}
>
  フェッチ
</button>
<button
  {disabled}
  title={noRemote ? 'リモートが設定されていません' : '上流から取り込む'}
  onclick={() => void app.pull()}
>
  プル
</button>
<button
  {disabled}
  title={noRemote ? 'リモートが設定されていません' : 'ブランチを選んでプッシュする'}
  aria-haspopup="dialog"
  onclick={() => app.openPushDialog()}
>
  プッシュ
</button>

{#if fetchMenu !== null}
  {@const open = fetchMenu}
  <FileContextMenu
    x={open.x}
    y={open.y}
    onclose={() => (fetchMenu = null)}
    actions={app.remotes.map((remote) => ({
      label: remote,
      onclick: () => void app.fetch(remote),
    }))}
  />
{/if}
