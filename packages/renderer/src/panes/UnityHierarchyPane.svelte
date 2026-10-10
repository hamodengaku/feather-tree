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
  import { adoptedSide, conflictEntryIndex, isConflictNode } from '../lib/unityConflict.js';
  import type { UnityNodeDto } from '@feathertree/ipc';

  const nodes = $derived(app.unityView?.nodes ?? []);
  // コンポーネントは名前をクリックするまで畳む（2026-10-02、利用者の指示）。インデントは従来どおり
  const rows = $derived(visibleUnityRows(nodes, app.unityExpanded, app.unityComponentsShown));

  /*
   * 未マージ（2026-10-10）。自分側と相手側は対等なので、決まるまでは削除の斜線も追加・削除の色も付けない。
   * 決まったら（選んだ・自動で決まった）採用側にそのノードが無ければ斜線、あれば強調。
   */
  const conflict = $derived(app.unityView?.conflict ?? null);
  const conflictIndex = $derived(conflictEntryIndex(conflict));
  const units = $derived(new Set(conflict?.units ?? []));

  /** 採用側の結果: そのノードが残る（kept）・消える（dropped）・未決定や違いなし（null）。 */
  function outcome(node: UnityNodeDto): 'kept' | 'dropped' | null {
    const side = adoptedSide(conflict, conflictIndex, app.unityChoices, node.id);
    if (side === null) return null;
    // 旧側＝自分側、新側＝相手側。added は相手側にだけ、removed は自分側にだけある
    const present = side === 'ours' ? node.mark !== 'added' : node.mark !== 'removed';
    return present ? 'kept' : 'dropped';
  }

  /**
   * 行の字下げ。コンポーネントは**半段だけ**下げる（2026-10-10、利用者の指示）。
   * 子 GameObject（1 段）と同じ深さに並ぶと、階層の一段と見間違えるため。
   */
  function indentOf(node: UnityNodeDto): number {
    const step = 14;
    if (node.kind === 'component') return 4 + Math.max(0, node.depth - 1) * step + step / 2;
    return 4 + node.depth * step;
  }

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
      スクリプト名の解決（要件 11）の入口は、未解決の MonoBehaviour の行に置く（2026-09-30）。
      名前の分からない行のすぐ隣にあるほうが、何のためのボタンか説明が要らない。
      ここには解決した後の件数だけを出す。
    -->
    <span class="push"></span>
    {#if app.unityScriptsResolved !== null}
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
        class:conflict-mode={conflict !== null}
        class:kept={outcome(row.node) === 'kept'}
        class:dropped={outcome(row.node) === 'dropped'}
        class:conflicted={isConflictNode(conflict, conflictIndex, row.node.id)}
        style:padding-left="{indentOf(row.node)}px"
        role="treeitem"
        aria-selected={row.node.id === app.unitySelectedNode}
        aria-expanded={row.hasChildren ? row.expanded : undefined}
        tabindex="-1"
        onclick={() => void app.clickUnityNode(row.node.id, row.node.kind)}
        onkeydown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void app.clickUnityNode(row.node.id, row.node.kind);
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

        <span
          class="name"
          title="{kindLabel(row.node.kind)}: {row.node.name}">{row.node.name}</span
        >

        <!--
          並び（2026-10-10、利用者の指示）:
            [▸][立方体][名前][継承][(i) 数][● 印] [余白] [スクリプト名を検索][自分側を採用 / 相手側を採用]
          名前に横づけするもの（コンポーネント・印）は名前の直後、操作のボタンは右寄せ。
          縮むのは名前だけ（名前が長くても、後ろのボタン・数字・印は見切れない）。
        -->

        {#if row.node.inherited}
          <!--
            stripped（ネスト Prefab / Variant の元から継承した代理）。本体は元 Prefab にあり、
            このファイルには参照しか無い。持ち込んだ PrefabInstance の下に並ぶ。
          -->
          <span
            class="badge"
            title="元 Prefab から継承したオブジェクトです（本体は上の Prefab インスタンスの元 Prefab にあり、このファイルには参照だけがあります）"
            >継承</span
          >
        {/if}

        <!--
          コンポーネントの開閉。記号は (i)（i を丸で囲んだもの。2026-10-10、利用者の指示）。
          ▸ は子 GameObject 専用。開いている間も色は変えない（以前の強調色の枠は廃止）。
          畳んだコンポーネントの中に変更があれば ● を添える。名前のクリックでも開閉できる。
        -->
        {#if row.node.kind !== 'component' && row.hasComponents}
          {@const open = app.unityComponentsShown.has(row.node.id)}
          <button
            class="comps"
            type="button"
            title={open ? 'コンポーネントを畳む' : 'コンポーネントを表示'}
            aria-label="{open ? 'コンポーネントを畳む' : 'コンポーネントを表示'}（{row.componentCount} 件{row.hiddenComponentChange ? '・変更あり' : ''}）"
            aria-expanded={open}
            onclick={(event) => {
              event.stopPropagation();
              app.toggleUnityComponents(row.node.id);
            }}
            ><svg class="info" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <mask id="ft-info-{row.node.id}">
                <rect width="16" height="16" fill="white" />
                <circle cx="8" cy="4.6" r="1.2" fill="black" />
                <rect x="6.9" y="6.8" width="2.2" height="5.6" rx="0.6" fill="black" />
              </mask>
              <circle cx="8" cy="8" r="7.5" fill="currentColor" mask="url(#ft-info-{row.node.id})" />
            </svg>{row.componentCount}{#if row.hiddenComponentChange}<span class="comps-dot" aria-hidden="true"
                >●</span
              >{/if}</button
          >
        {/if}

        <!--
          自分の印（＋ − ⇄ ●）と「畳まれた下に変更あり」の ● は**併記**する（2026-10-10、利用者の指示）。
          自分の印が出ていると下の変更の印が消える、では親を畳んだときに下の変更へたどり着けない。
          下の変更の印も自分の変更と同じ ●（中点は見づらい）。どちらの ● かは開けば分かる
          （開くと ● が子の行へ移る）。自分が ● のときは 2 つ並べない。
          追加・削除の下は子孫も同じ印なので、重ねて出さない。
        -->
        {#if row.node.mark !== 'same'}
          <span class="mark" title={markLabel(row.node.mark)} aria-label={markLabel(row.node.mark)}
            >{markSymbol(row.node.mark)}</span
          >
        {/if}
        {#if row.hiddenChildChange && (row.node.mark === 'same' || row.node.mark === 'moved')}
          <span class="mark" title="この下に変更があります" aria-label="この下に変更があります">●</span>
        {/if}

        <span class="push"></span>

        <!--
          スクリプト名の解決（要件 11）。**押したときだけ走る。**
          リポジトリ内の *.meta を数千件読むので、ファイルを選ぶたびに自動で
          走らせてよい処理ではない（CLAUDE.md「ファイル I/O が非常に遅い」）。
          1 回走れば全行がまとめて解決する。**何度でも押せる**（2026-10-02、利用者の指示）——
          後からスクリプトを足した・.meta を付け替えたときに、押し直せば走査し直す。
          出すのは m_Script を持つ MonoBehaviour すべて（名前の解決の有無・既知表・DLL を問わない。
          2026-10-03、利用者の指示）。継承（stripped）・参照の欠けた「純粋な MonoBehaviour」には出さない。
        -->
        {#if row.node.scriptSearchable}
          <button
            class="resolve"
            type="button"
            disabled={app.unityScriptsIndexing}
            title="リポジトリ内と Library/PackageCache の .meta を読んで、MonoBehaviour のスクリプト名と PrefabInstance の元 Prefab 名を表示します（git は動きません。ファイル数によっては数秒〜数十秒かかります）"
            onclick={(event) => {
              event.stopPropagation();
              void app.indexUnityScripts();
            }}>{app.unityScriptsIndexing ? '検索中…' : 'スクリプト名を検索'}</button
          >
        {/if}

        {#if units.has(row.node.id)}
          <!-- GameObject 単位の解消（2026-10-10）。表記は「採用」に統一（利用者の指示）。同じ側をもう一度押すと選択を外す -->
          {@const chosen = app.unityChoices.get(row.node.id)}
          <span class="pick" role="group" aria-label="採用する側">
            <button
              type="button"
              class="ours"
              aria-pressed={chosen === 'ours'}
              title="この GameObject（コンポーネントを含む）は自分側（ours）の内容を残す"
              onclick={(event) => {
                event.stopPropagation();
                app.chooseUnityUnit(row.node.id, 'ours');
              }}>自分側を採用</button
            >
            <button
              type="button"
              class="theirs"
              aria-pressed={chosen === 'theirs'}
              title="この GameObject（コンポーネントを含む）は相手側（theirs）の内容を残す"
              onclick={(event) => {
                event.stopPropagation();
                app.chooseUnityUnit(row.node.id, 'theirs');
              }}>相手側を採用</button
            >
          </span>
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

  /* 見出しの右寄せ。これより後ろのものは右端に詰める。 */
  .push {
    flex: 1 1 auto;
  }

  .resolve {
    flex: 0 0 auto;
    padding: 0 6px;
    font-size: calc(var(--app-font-size-ui) * 0.8);
    line-height: 1.4;
  }

  .badge {
    flex: 0 0 auto;
    padding: 0 4px;
    border: 1px solid var(--app-border-subtle);
    border-radius: var(--app-metric-radius);
    color: var(--app-text-secondary);
    font-size: calc(var(--app-font-size-ui) * 0.8);
    line-height: 1.3;
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

  /*
    コンポーネントは一段控えめにして、ゲームオブジェクトの並びを読みやすくする。
    小さく・斜体にして、子 GameObject と字面でも見分けられるようにする（2026-10-10）。
  */
  .row.component .name {
    color: var(--app-text-secondary);
    font-size: calc(var(--app-font-size-ui) * 0.9);
    font-style: italic;
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

  /* 未マージ: 決まるまでは対等。追加・削除の色と斜線を付けず、違いだけを変更色で示す */
  .row.conflict-mode.added .name,
  .row.conflict-mode.removed .name {
    color: var(--app-text-modified);
    text-decoration: none;
  }

  /* 採用側に残る（強調）／採用側に無いので消える（斜線） */
  /* 両側が変えた衝突のノード（GameObject・コンポーネント）はコンフリ色。差分ペインの衝突行と同じ色 */
  .row.conflict-mode.conflicted .name {
    color: var(--app-text-conflict);
  }

  .row.conflict-mode.kept .name {
    font-weight: 700;
  }

  .row.conflict-mode.dropped .name {
    color: var(--app-text-secondary);
    text-decoration: line-through;
  }

  /* 名前に横づけするものと、右寄せのボタンの境目 */
  .push {
    flex: 1 1 auto;
    min-width: 4px;
  }

  .pick {
    flex: 0 0 auto;
    display: inline-flex;
    gap: 2px;
  }

  .pick button {
    padding: 0 5px;
    font-size: calc(var(--app-font-size-ui) * 0.8);
    line-height: 1.4;
  }

  .pick button.ours[aria-pressed='true'] {
    background: var(--app-conflict-ours-bg);
    outline: 2px solid var(--app-text-conflict);
  }

  .pick button.theirs[aria-pressed='true'] {
    background: var(--app-conflict-theirs-bg);
    outline: 2px solid var(--app-text-conflict);
  }

  .twisty {
    flex: 0 0 auto;
    width: 14px;
    padding: 0;
    background: none;
    border: none;
    color: var(--app-text-secondary);
    /* 以前の 1.5 倍（0.9 → 1.35。2026-10-10、利用者の指示）。幅は据え置き（字下げの揃えを崩さない） */
    font-size: calc(var(--app-font-size-ui) * 1.35);
    line-height: 1;
    overflow: visible;
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

  /* 縮むのは名前だけ。後ろのボタン・印は見切れさせない */
  .name {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .comps {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 5px;
    border: 1px solid var(--app-border-subtle);
    border-radius: var(--app-metric-radius);
    background: none;
    color: var(--app-text-secondary);
    font-size: calc(var(--app-font-size-ui) * 0.8);
    line-height: 1.4;
    white-space: nowrap;
  }

  .comps-dot {
    margin-left: 2px;
  }

  .mark {
    flex: 0 0 auto;
    font-size: calc(var(--app-font-size-ui) * 0.9);
  }
</style>
