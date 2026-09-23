<script lang="ts">
  /*
   * Prefab ヒエラルキー（決定 32 / 要件 7）。
   *
   * Unity の Hierarchy ウィンドウと違って、**コンポーネントも親 GameObject の
   * 子として並ぶ**。「どのゲームオブジェクトの、どのコンポーネントが変わったか」を
   * 1 本の木で読めるようにするのがこのモードの目的なので、
   * コンポーネントを別の場所（Inspector 相当）へ追い出さない。
   *
   * 畳み／展開の計算は純関数（`lib/unityTree.ts`）に置いてある。
   * 初期状態は全折りたたみで、変更のある節までの経路だけが開いている。
   */
  import { app } from '../lib/appState.svelte.js';
  import { visibleUnityRows } from '../lib/unityTree.js';
  import type { UnityNodeDto } from '@feathertree/ipc';

  const nodes = $derived(app.unityView?.nodes ?? []);
  const rows = $derived(visibleUnityRows(nodes, app.unityExpanded));

  /** 印の記号。色だけに頼らない（色覚に依存しない読み方を残す）。 */
  function markSymbol(mark: UnityNodeDto['mark']): string {
    switch (mark) {
      case 'added':
        return '＋';
      case 'removed':
        return '−';
      case 'moved':
        return '⇄';
      case 'changed':
        return '●';
      case 'same':
        return '';
    }
  }

  function markLabel(mark: UnityNodeDto['mark']): string {
    switch (mark) {
      case 'added':
        return '追加';
      case 'removed':
        return '削除';
      case 'moved':
        return '移動';
      case 'changed':
        return '変更';
      case 'same':
        return '';
    }
  }

  /** ゲームオブジェクトとコンポーネントを字面でも見分けられるようにする。 */
  function kindLabel(kind: UnityNodeDto['kind']): string {
    switch (kind) {
      case 'gameObject':
        return 'ゲームオブジェクト';
      case 'prefabInstance':
        return 'Prefab インスタンス';
      case 'component':
        return 'コンポーネント';
    }
  }
</script>

<div class="unity-hierarchy-pane">
  <div class="head">
    <span class="title">ヒエラルキー</span>

    <!--
      スクリプト名の解決（要件 11）。**押したときだけ走る。**
      リポジトリ内の *.meta を数千件読むので、ファイルを選ぶたびに自動で
      走らせてよい処理ではない（CLAUDE.md「ファイル I/O が非常に遅い」）。
    -->
    {#if app.unityScriptsResolved === null}
      <button
        class="resolve"
        type="button"
        disabled={app.unityScriptsIndexing}
        title="リポジトリ内の .meta を読んで、MonoBehaviour のスクリプト名と PrefabInstance の元 Prefab 名を表示します（git は動きません。ファイル数によっては数秒かかります）"
        onclick={() => void app.indexUnityScripts()}
        >{app.unityScriptsIndexing ? '解決中…' : 'スクリプト名を解決'}</button
      >
    {:else}
      <span class="hint" title="{String(app.unityScriptsResolved)} 件の guid に名前が付きました"
        >名前 {app.unityScriptsResolved} 件</span
      >
    {/if}

    <!--
      同一性を fileID で見ていることを明記する（F-4）。Unity が fileID を振り直すと
      全ノードが「削除＋追加」に見えるので、そのときに理由を探せるようにしておく。
    -->
    <span class="hint" title="ゲームオブジェクトとコンポーネントの同一性は fileID で判定しています。Unity が fileID を振り直した場合、すべてが追加・削除として表示されます。"
      >fileID で照合</span
    >
  </div>

  <div class="list" role="tree" aria-label="Prefab ヒエラルキー">
    {#each rows as row (row.node.id)}
      <div
        class="row {row.node.kind}"
        class:selected={row.node.id === app.unitySelectedNode}
        class:changed={row.node.mark === 'changed'}
        class:added={row.node.mark === 'added'}
        class:removed={row.node.mark === 'removed'}
        class:moved={row.node.mark === 'moved'}
        style:padding-left="{4 + row.node.depth * 14}px"
        role="treeitem"
        aria-selected={row.node.id === app.unitySelectedNode}
        aria-expanded={row.hasChildren ? row.expanded : undefined}
        tabindex="-1"
        onclick={() => void app.selectUnityNode(row.node.id)}
        onkeydown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void app.selectUnityNode(row.node.id);
          }
        }}
      >
        {#if row.hasChildren}
          <button
            class="twisty"
            type="button"
            title={row.expanded ? '折りたたむ' : '展開する'}
            aria-label={row.expanded ? '折りたたむ' : '展開する'}
            onclick={(event) => {
              // 行の選択とは別の操作。親へ伝えない
              event.stopPropagation();
              app.toggleUnityNode(row.node.id);
            }}>{row.expanded ? '▾' : '▸'}</button
          >
        {:else}
          <span class="twisty spacer"></span>
        {/if}

        <!--
          ゲームオブジェクトとコンポーネントを**字面を読む前に**見分けられるようにする。
          コンポーネントは同じ幅の空きを置いて名前の頭を揃える（印の有無だけが違いになる）。

          立方体は等角投影。外形の六角形と、中心から上左・上右・真下へ伸びる 3 本の稜線で
          「上面・左面・右面の 3 面が見えている」形を作る（中心が手前上の角）。
          縦帯の Unity モードのアイコンも同じ形にしてある（ActivityBar.svelte）。
        -->
        {#if row.node.kind === 'component'}
          <span class="obj-icon spacer"></span>
        {:else}
          <svg class="obj-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
            <path
              d="M2.4 4.75L8 8l5.6-3.25M8 8v6.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
          </svg>
        {/if}

        <span class="name" title="{kindLabel(row.node.kind)}: {row.node.name}">{row.node.name}</span>

        {#if row.node.mark !== 'same'}
          <span class="mark" title={markLabel(row.node.mark)} aria-label={markLabel(row.node.mark)}
            >{markSymbol(row.node.mark)}</span
          >
        {:else if row.node.hasChangedDescendant && !row.expanded}
          <!-- 畳まれた下に変更がある。開かずとも気づけるようにする（要件 7） -->
          <span class="mark faint" title="この下に変更があります" aria-label="この下に変更があります"
            >·</span
          >
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .unity-hierarchy-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-right: 1px solid var(--app-border-subtle);
  }

  .head {
    flex: 0 0 auto;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--app-border-subtle);
    background: var(--app-bg-raised);
  }

  .title {
    font-size: var(--app-font-size-ui);
    color: var(--app-text-primary);
  }

  .resolve {
    margin-left: auto;
    flex: 0 0 auto;
    font-size: calc(var(--app-font-size-ui) * 0.85);
  }

  /* 最初の 1 つだけを右へ押しやる（後ろに並ぶものは詰める）。 */
  .hint:first-of-type {
    margin-left: auto;
  }

  .hint {
    flex: 0 0 auto;
    font-size: calc(var(--app-font-size-ui) * 0.85);
    color: var(--app-text-secondary);
  }

  .list {
    flex: 1 1 auto;
    overflow: auto;
    min-height: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-right: 8px;
    height: 22px;
    font-size: var(--app-font-size-ui);
    color: var(--app-text-primary);
    white-space: nowrap;
  }

  /* コンポーネントは一段控えめにして、ゲームオブジェクトの並びを読みやすくする。 */
  .row.component .name {
    color: var(--app-text-secondary);
  }

  .row:hover {
    background: var(--app-bg-hover);
  }

  .row.selected {
    background: var(--app-bg-hover);
    box-shadow: inset 2px 0 0 var(--app-accent);
  }

  .row.changed .name {
    color: var(--app-text-modified);
  }

  .row.added .name {
    color: var(--app-text-added);
  }

  .row.removed .name {
    color: var(--app-text-removed);
    text-decoration: line-through;
  }

  .row.moved .name {
    color: var(--app-text-untracked);
  }

  .twisty {
    flex: 0 0 auto;
    width: 14px;
    padding: 0;
    background: none;
    border: none;
    color: var(--app-text-secondary);
    font-size: calc(var(--app-font-size-ui) * 0.9);
    line-height: 1;
  }

  .twisty.spacer {
    display: inline-block;
  }

  /*
    種別の印（立方体）。**状態の色（変更・追加・削除）には染めない**——
    これは「これはゲームオブジェクトだ」を言うためのもので、
    名前側に出ている状態の色と競わせない。
  */
  .obj-icon {
    flex: 0 0 auto;
    width: 14px;
    height: 14px;
    color: var(--app-text-secondary);
  }

  /* コンポーネントの側。同じ幅を空けて名前の頭を揃える。 */
  .obj-icon.spacer {
    display: inline-block;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mark {
    margin-left: auto;
    flex: 0 0 auto;
    font-size: calc(var(--app-font-size-ui) * 0.9);
  }

  .mark.faint {
    color: var(--app-text-secondary);
  }
</style>
