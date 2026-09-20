<script lang="ts">
  /*
   * Stash 解放モードの上半分（決定 31）。退避した stash の一覧。
   *
   * 一覧は**このペインが見えているときにだけ**取る。他のモードでいる限り #28 は走らない
   * （コミットログペインと同じ約束。見えていないもののために git を起動しない）。
   *
   * **仮想化していない。** stash スタックは reflog 1 本で、数百件になることはまず無い
   * （数万件になりうるコミットログとは前提が違う）。行の高さも可変にしてあるので、
   * 仮想化を入れると得るものより失うもののほうが大きい。
   *
   * 展開・破棄の口は**右クリックだけ**にしてある。行のダブルクリックに割り当てると、
   * 「選んで中身を見るつもりが展開されていた」が起きる——pop は作業ツリーを書き換えるので、
   * 取り消すのに手間が掛かる（決定 16 の「不可逆なものは確認する」の一歩手前の配慮）。
   */
  import type { StashEntryDto } from '@feathertree/ipc';
  import { app } from '../lib/appState.svelte.js';
  import FileContextMenu from '../components/FileContextMenu.svelte';

  // モードに入った瞬間・タブを切り替えた瞬間に、まだ取っていなければ取る。
  // 取得済みならそのまま見せるだけで IPC は呼ばない（タブ切替の規約）。
  $effect(() => {
    void app.activeId;
    void app.ensureStashes();
  });

  let contextMenu = $state<{ x: number; y: number; entry: StashEntryDto } | null>(null);

  /**
   * 一覧に出す件名。`%gs` は `On main: 退避のメモ` の形なので、前置きと本文に分ける。
   * 前置き（どのブランチで積んだか）は情報なので消さず、弱い色で残す。
   */
  function splitMessage(message: string): { readonly on: string | null; readonly text: string } {
    const m = /^(On [^:]+|WIP on [^:]+): ?(.*)$/s.exec(message);
    if (m === null) return { on: null, text: message };
    return { on: m[1] ?? null, text: m[2] ?? '' };
  }

  function dateText(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso;
    const p2 = (n: number): string => String(n).padStart(2, '0');
    return `${String(at.getFullYear())}-${p2(at.getMonth() + 1)}-${p2(at.getDate())} ${p2(at.getHours())}:${p2(at.getMinutes())}`;
  }

  function handleContextMenu(entry: StashEntryDto, event: MouseEvent): void {
    // 右クリックした行を選び直す。見えている詳細と操作の対象がずれないようにする
    if (app.selectedStash !== entry.oid) void app.selectStash(entry.oid);
    contextMenu = { x: event.clientX, y: event.clientY, entry };
  }

  function refOf(entry: StashEntryDto): { readonly index: number; readonly oid: string } {
    return { index: entry.index, oid: entry.oid };
  }
</script>

<div class="pane stash-list-pane">
  <header>
    <h2>stash</h2>
    <span class="meta">
      {#if app.stashes.length > 0}
        {app.stashes.length} 件
      {/if}
    </span>
    <button
      class="reload"
      disabled={app.busy || app.stashesLoading || app.activeId === null}
      title="stash の一覧だけを取り直す（git stash list）"
      onclick={() => void app.loadStashes()}
    >
      再読み込み
    </button>
  </header>

  {#if app.activeId === null}
    <p class="empty">リポジトリを開くと stash を表示します。</p>
  {:else if app.stashesLoading && app.stashes.length === 0}
    <p class="empty">読み込み中…</p>
  {:else if app.stashes.length === 0}
    <p class="empty">
      stash はありません。Stash 保存モードで、ステージした差分だけを退避できます。
    </p>
  {:else}
    <div class="list" role="listbox" aria-label="stash の一覧">
      {#each app.stashes as entry (entry.oid)}
        {@const parts = splitMessage(entry.message)}
        <div
          class="row"
          class:selected={entry.oid === app.selectedStash}
          role="option"
          aria-selected={entry.oid === app.selectedStash}
          tabindex="-1"
          title={`${entry.ref}  ${entry.message}`}
          onclick={() => void app.selectStash(entry.oid)}
          oncontextmenu={(event) => {
            event.preventDefault();
            handleContextMenu(entry, event);
          }}
          onkeydown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              void app.selectStash(entry.oid);
            }
          }}
        >
          <span class="ref">{entry.ref}</span>
          <span class="message">
            {#if parts.on !== null}<span class="on">{parts.on}:</span>{/if}
            {parts.text}
          </span>
          <!--
            このアプリ以外で作られた stash（親が 3 つ＝ -u 付き）には印を出す。
            中身の出方が違う（未追跡としてだけ入っているファイルがありうる）ので、
            「同じ見た目でも由来が違う」ことを黙らない
          -->
          {#if !entry.staged}
            <span class="foreign" title="FeatherTree 以外で作られた stash（未追跡ファイルを含みます）">
              外部
            </span>
          {/if}
          <span class="at">{dateText(entry.authoredAt)}</span>
        </div>
      {/each}
    </div>

    <!--
      展開した差分は**すべて**未ステージに揃える（決定 31）。ステージした状態で
      退避した人にとっては意外な挙動なので、操作する前に読める場所に 1 行だけ置く
      （メニューの中に書いても、押すと決めた後にしか読まれない）。
    -->
    <p class="footer">
      右クリックで展開・破棄。展開した差分は<strong>すべて未ステージ</strong>として戻ります。
    </p>
  {/if}
</div>

{#if contextMenu !== null}
  {@const menu = contextMenu}
  <FileContextMenu
    x={menu.x}
    y={menu.y}
    onclose={() => (contextMenu = null)}
    actions={[
      {
        label: 'ブランチに展開して stash を削除（pop）',
        disabled: app.busy,
        onclick: () => void app.applyStash(refOf(menu.entry), true),
      },
      {
        label: 'ブランチに展開して stash を残す（apply）',
        disabled: app.busy,
        onclick: () => void app.applyStash(refOf(menu.entry), false),
      },
      {
        label: 'stash を破棄（drop）',
        danger: true,
        disabled: app.busy,
        onclick: () => void app.dropStash(refOf(menu.entry)),
      },
    ]}
  />
{/if}

<style>
  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--app-metric-gap);
    padding: 6px 8px;
    background: var(--app-bg-surface);
    border-bottom: 1px solid var(--app-border-subtle);
  }

  h2 {
    margin: 0;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
    white-space: nowrap;
  }

  .meta {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .reload {
    flex: 0 0 auto;
    font-size: var(--app-font-size-mono);
    padding: 1px 8px;
  }

  .empty {
    margin: 16px;
    color: var(--app-text-muted);
  }

  .list {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  /* 一覧の下端に貼る 1 行。スクロールしても消えない（器の外に置いてある）。 */
  .footer {
    flex: 0 0 auto;
    margin: 0;
    padding: 4px 8px;
    background: var(--app-bg-surface);
    border-top: 1px solid var(--app-border-subtle);
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--app-metric-gap);
    height: var(--app-metric-row-height);
    padding: 0 8px;
    white-space: nowrap;
    cursor: default;
  }

  .row:hover {
    background: var(--app-bg-hover);
  }

  .row.selected {
    background: var(--app-bg-selected);
  }

  .row:focus-visible {
    outline: 1px solid var(--app-accent);
    outline-offset: -1px;
  }

  /* 番号はコミットの短縮ハッシュと同じ役どころ。等幅で桁を揃える。 */
  .ref {
    flex: 0 0 auto;
    width: 76px;
    color: var(--app-text-muted);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  .message {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* `On main:` の部分。読み飛ばせるように本文より弱く出す。 */
  .on {
    color: var(--app-text-muted);
  }

  .foreign {
    flex: 0 0 auto;
    padding: 0 6px;
    border: 1px solid var(--app-border-strong);
    border-radius: var(--app-metric-radius);
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .at {
    flex: 0 0 auto;
    color: var(--app-text-muted);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }
</style>
