<script lang="ts">
  /*
   * 差分モードの右ペイン。**作業ツリーの差分を「ステージする／戻す」ための道具**で、
   * hunk ボタンと 1 行モード（対応表 #33 / #34）が本体に織り込まれている。
   *
   * コミットの差分を見るだけなら components/ReadonlyDiffView.svelte を使う。
   * あちらには操作の口が無い（過去のコミットからはステージできないため）。
   */
  import type {
    ConflictChoiceDto,
    ConflictLineDto,
    ConflictSectionDto,
    DiffHunkDto,
    DiffLineDto,
  } from '@feathertree/ipc';
  import { app } from '../lib/appState.svelte.js';
  import { hunkAllowsLines, singleLineSelection, wholeHunkSelection } from '../lib/diffSelection.js';

  const diff = $derived(app.diff);
  const lineCount = $derived(diff?.hunks.reduce((n, h) => n + h.lines.length, 0) ?? 0);
  const staged = $derived(app.selected?.staged === true);

  /* ---------------------------------------------------------------- コンフリクト */

  /**
   * 未マージのファイルを選んでいるとき、この右ペインは diff ではなく
   * **作業ツリーに書かれたコンフリクトマーカー**を出す（`git diff` は未マージに
   * 結合 diff しか出さず、マーカーの中身が読めないため）。
   */
  const conflict = $derived(app.conflict);
  const unmerged = $derived(app.selectedUnmerged);
  const conflictCount = $derived(conflict?.sections.length ?? 0);

  /**
   * 採用のボタンを出してよいか。
   *
   * マーカーの対応が取れない（入れ子・閉じていない）ファイルは読めたところまでを
   * 表示するだけにして、**採用はさせない**。中途半端に書き戻すと本文が壊れるので、
   * そこは外部ツールの仕事にする。main 側も同じ条件で断る。
   */
  const canResolve = $derived(conflict !== null && !conflict.malformed && !conflict.binary);

  /**
   * 採り方は 4 つだけ。「片側を採る」2 つと「両方を残す」2 つ（違いは挿入の順序）。
   * これより込み入った解決（片側の一部だけを採る等）はアプリでは扱わない。
   */
  const CHOICES: readonly {
    readonly choice: ConflictChoiceDto;
    readonly label: string;
    readonly title: string;
  }[] = [
    { choice: 'ours', label: 'ours', title: '自分の側（現在のブランチ）だけを残す' },
    { choice: 'theirs', label: 'theirs', title: '相手の側（取り込む側）だけを残す' },
    { choice: 'ours-theirs', label: '両方 ours→theirs', title: '両方を残す。ours を先に置く' },
    { choice: 'theirs-ours', label: '両方 theirs→ours', title: '両方を残す。theirs を先に置く' },
  ];

  /** ラベルはマーカーの後ろの文字列。git が付けなかった場合（空）は側の名前で代用する。 */
  function sideLabel(label: string, fallback: string): string {
    return label.length === 0 ? fallback : label;
  }

  /**
   * 衝突の見出し。
   *
   * **1 行の文字列として組み立てる。** 置き場の `.hunk-text` は横スクロールに耐えるため
   * `white-space: pre` なので、テンプレート側で改行して書くとその改行がそのまま描画される。
   */
  function sectionTitle(section: ConflictSectionDto, position: number, total: number): string {
    const sides = `${sideLabel(section.ourLabel, 'ours')} ↔ ${sideLabel(section.theirLabel, 'theirs')}`;
    return `衝突 ${String(position)}/${String(total)}・${String(section.startLine)}〜${String(section.endLine)} 行 ／ ${sides}`;
  }

  async function resolve(section: ConflictSectionDto, choice: ConflictChoiceDto): Promise<void> {
    if (app.busy) return;
    await app.resolveConflict(section, choice);
  }

  /** hunk / 行の操作ができるか。判定は main（canBuildPatch）に任せて、ここでは結果を見るだけ。 */
  const hunkOps = $derived(diff !== null && diff.hunkStageable);
  const actionLabel = $derived(staged ? 'アンステージ' : 'ステージ');

  /**
   * hunk ヘッダの表示文字列。
   *
   * git の生ヘッダ末尾には関数コンテキスト（囲んでいる宣言の名前）が付くが、
   * 画面では行番号だけでよいので構造体から組み立て直す。
   * hunk.header そのものは適用直前の照合（古さの指紋）に使うので触らない。
   */
  function headerText(hunk: DiffHunkDto): string {
    return `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`;
  }

  /**
   * 「1 行だけ」モードにしている hunk の添字。null なら通常表示。
   *
   * 行のクリックはこのモード中だけ効く。モードは同時に 1 つだけで、
   * 背景を強調する場所が常に 1 か所に限られるので、今どこを行単位で
   * 触っているのかが一目で分かる。
   */
  let lineModeHunk = $state<number | null>(null);

  /** ファイルを選び直したら行モードから抜ける（hunk の添字は別ファイルでは意味を持たない）。 */
  const fileKey = $derived(
    app.selected === null ? '' : `${app.selected.path}:${String(app.selected.staged)}`,
  );
  $effect(() => {
    void fileKey;
    lineModeHunk = null;
  });

  /**
   * 実際に行モードが効いている hunk。
   *
   * 1 行適用するたびに差分を取り直すので、hunk が消えて数が減ることがある。
   * 添字が範囲外になったら通常表示へ戻す。
   */
  const activeLineHunk = $derived(
    lineModeHunk !== null && diff !== null && lineModeHunk < diff.hunks.length ? lineModeHunk : null,
  );

  /** その行を単独で操作できるか（文脈行と末尾改行マーカーは対象外）。 */
  function isChangeLine(line: DiffLineDto): boolean {
    return line.kind === 'added' || line.kind === 'removed';
  }

  function toggleLineMode(hunkIndex: number): void {
    lineModeHunk = activeLineHunk === hunkIndex ? null : hunkIndex;
  }

  /** hunk ヘッダのボタン。行モード中でも常にその hunk 全体を対象にする。 */
  async function applyWholeHunk(hunkIndex: number): Promise<void> {
    if (diff === null) return;
    const hunks = wholeHunkSelection(diff, hunkIndex);
    if (staged) await app.unstageHunks(hunks);
    else await app.stageHunks(hunks);
  }

  /** 行モード中のクリック。溜めずに、その場で 1 行だけ適用する。 */
  async function applyLine(hunkIndex: number, lineIndex: number): Promise<void> {
    if (diff === null || app.busy) return;
    const hunks = singleLineSelection(diff, hunkIndex, lineIndex);
    if (staged) await app.unstageHunks(hunks);
    else await app.stageHunks(hunks);
  }
</script>

{#snippet lineCells(line: DiffLineDto)}
  <span class="no">{line.oldLineNo ?? ''}</span>
  <span class="no">{line.newLineNo ?? ''}</span>
  <span class="sign">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span>
  <span class="text">{line.text}</span>
{/snippet}

<!-- コンフリクトは「どちらの側か」だけが要るので、行番号は作業ツリーの 1 列だけ -->
{#snippet conflictCells(line: ConflictLineDto)}
  <span class="no">{line.lineNo}</span>
  <span class="text">{line.text}</span>
{/snippet}

<div class="pane">
  <header>
    <h2>{app.selected?.path ?? '差分'}</h2>
    {#if unmerged}
      <span class="meta conflict">
        コンフリクト{#if conflictCount > 0}・{conflictCount} 件{/if}
      </span>
    {:else if diff !== null}
      <span class="meta">
        {staged ? 'ステージ済み' : '未ステージ'}
        {#if diff.truncated}・打ち切り{/if}
        {#if lineCount > 0}・{lineCount} 行{/if}
      </span>
    {/if}
  </header>

  <div class="body">
    {#if app.diffLoading}
      <p class="empty">読み込み中…</p>
    {:else if app.selected === null}
      <p class="empty">ファイルを選択すると差分を表示します。</p>
    {:else if unmerged}
      {#if conflict === null}
        <p class="empty">
          ファイルが作業ツリーにありません（削除との衝突）。残すならステージ、消すなら破棄してください。
        </p>
      {:else if conflict.binary}
        <p class="empty">バイナリファイルのコンフリクトです。外部ツールで解決してください。</p>
      {:else if conflict.sections.length === 0}
        <p class="empty">
          コンフリクトマーカーは残っていません。ステージすると解決済みとして記録されます。
        </p>
      {:else}
        <p class="notice" class:warn={conflict.malformed}>
          {#if conflict.malformed}
            マーカーの対応が取れていません（入れ子か、閉じていないマーカーがあります）。
            このファイルは外部ツールで解決してください。
          {:else}
            マージで衝突しています。採る側を選ぶと作業ツリーのファイルを書き換えます。
            これより細かい解決が要るときは外部ツールを使ってください。
            <strong>ステージするまで解決済みにはなりません。</strong>
          {/if}
        </p>

        <div class="diff">
          {#each conflict.sections as section, i (section.index)}
            <div class="hunk conflict">
              <div class="hunk-header">
                <span class="hunk-text">{sectionTitle(section, i + 1, conflict.sections.length)}</span>
                {#if canResolve}
                  <div class="hunk-buttons">
                    {#each CHOICES as pick (pick.choice)}
                      <button
                        class="hunk-action"
                        disabled={app.busy}
                        title={pick.title}
                        onclick={() => void resolve(section, pick.choice)}
                      >
                        {pick.label}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
              <div class="hunk-lines">
                {#each section.lines as line, k (k)}
                  <div class="line c-{line.kind}">{@render conflictCells(line)}</div>
                {/each}
                {#if section.truncated}
                  <div class="line c-context">
                    <span class="no"></span>
                    <span class="text">（行数上限によりここから省略されました）</span>
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {:else if diff === null}
      <p class="empty">差分はありません。</p>
    {:else if diff.binary}
      <p class="empty">バイナリファイルのため差分を表示できません。</p>
    {:else if diff.hunks.length === 0}
      <p class="empty">差分はありません。</p>
    {:else}
      <!-- Unified 表示。パーサと描画を分離してあるので side-by-side は後付けできる -->
      <div class="diff">
        {#each diff.hunks as hunk, hunkIndex (hunkIndex)}
          {@const lineMode = activeLineHunk === hunkIndex}
          {@const canPickLines = hunkOps && hunkAllowsLines(diff, hunkIndex)}
          <!-- hunk 1 つ分の箱。マウスを乗せたときだけ外枠とボタンを出す -->
          <div class="hunk" class:line-mode={lineMode}>
            <div class="hunk-header">
              <span class="hunk-text">{headerText(hunk)}</span>
              {#if hunkOps}
                <div class="hunk-buttons">
                  {#if canPickLines}
                    <button
                      class="hunk-line-mode"
                      class:active={lineMode}
                      aria-pressed={lineMode}
                      disabled={app.busy}
                      title={lineMode
                        ? 'もう一度押すと通常表示に戻る'
                        : `行をクリックして 1 行ずつ${actionLabel}する`}
                      onclick={() => toggleLineMode(hunkIndex)}
                    >
                      1行だけ{actionLabel}
                    </button>
                  {/if}
                  <button
                    class="hunk-action"
                    disabled={app.busy}
                    title="この hunk をまとめて{actionLabel}"
                    onclick={() => void applyWholeHunk(hunkIndex)}
                  >
                    hunk を{actionLabel}
                  </button>
                </div>
              {/if}
            </div>
            <div class="hunk-lines">
              {#each hunk.lines as line, i (i)}
                {#if lineMode && isChangeLine(line)}
                  <div
                    class="line {line.kind} pickable"
                    role="button"
                    tabindex="0"
                    title="クリックでこの 1 行を{actionLabel}"
                    onclick={() => void applyLine(hunkIndex, i)}
                    onkeydown={(event) => {
                      if (event.key === ' ' || event.key === 'Enter') {
                        event.preventDefault();
                        void applyLine(hunkIndex, i);
                      }
                    }}
                  >
                    {@render lineCells(line)}
                  </div>
                {:else}
                  <div class="line {line.kind}">{@render lineCells(line)}</div>
                {/if}
              {/each}
            </div>
          </div>
        {/each}
        {#if diff.truncated}
          <div class="hunk-header">
            <span class="hunk-text">これ以降は行数上限により省略されました。</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    /* main.panes のグリッドアイテムそのもの。min-width の既定は auto（= min-content 幅）なので、
       トラックを狭めると中身が隣のペインへはみ出して描画される。0 にして必ずトラック内へ収める。 */
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: var(--app-metric-gap);
    padding: 6px 8px;
    background: var(--app-bg-surface);
    border-bottom: 1px solid var(--app-border-subtle);
    overflow: hidden;
  }

  h2 {
    margin: 0;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    flex: 0 0 auto;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  .empty {
    margin: 16px;
    color: var(--app-text-muted);
  }

  .meta.conflict {
    color: var(--app-text-conflict);
    font-weight: 700;
  }

  /*
    コンフリクトの説明帯。ペインの先頭に 1 回だけ出す。
    横スクロールしても読めるよう、幅は表示領域に合わせて折り返す（.diff の max-content に載せない）。
  */
  .notice {
    /* 横スクロールしても読めるよう、表示領域の左端に貼り付ける（.hunk-text と同じ理由） */
    position: sticky;
    left: 0;
    margin: 0;
    padding: 6px 8px;
    color: var(--app-text-secondary);
    background: var(--app-bg-raised);
    border-bottom: 1px solid var(--app-border-subtle);
    line-height: 1.5;
  }

  .notice.warn {
    color: var(--app-text-conflict);
  }

  .diff {
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    line-height: 17px;
    min-width: max-content;
  }

  /*
    hunk 1 つ分の箱。幅は .diff（min-width: max-content）に従うので、
    横に長いファイルでは右の枠線が画面外に出る。上・下・左が見えれば
    ひとかたまりだと分かるので、それで足りるものとする。
  */
  .hunk {
    outline: 1px solid transparent;
    outline-offset: -1px;
  }

  .hunk:hover,
  .hunk:focus-within {
    outline-color: var(--app-border-strong);
  }

  /* 行モード中の hunk は、ここを触っていることが分かるよう地色ごと強調する */
  .hunk.line-mode {
    background: var(--app-bg-raised);
  }

  .hunk.line-mode,
  .hunk.line-mode:hover {
    outline-color: var(--app-accent);
  }

  .hunk-header {
    display: flex;
    align-items: center;
    gap: var(--app-metric-gap);
    padding: 2px 8px;
    color: var(--app-text-secondary);
    background: var(--app-bg-raised);
    border-top: 1px solid var(--app-border-subtle);
    border-bottom: 1px solid var(--app-border-subtle);
  }

  /* 横スクロールしても @@ の表示が消えないよう、文字だけ左端に貼り付ける */
  .hunk-text {
    position: sticky;
    left: 8px;
    white-space: pre;
  }

  /*
    ボタンは「箱の内側の右上」に置く。箱の幅は最長行に合わせて画面より広くなりうるので、
    margin-left: auto で右端まで送ったうえで sticky で表示領域の右端に引き戻す。
    これで横スクロールの位置に関係なく必ず押せる。
  */
  .hunk-buttons {
    position: sticky;
    right: 4px;
    margin-left: auto;
    display: flex;
    flex: 0 0 auto;
    gap: 4px;
  }

  .hunk-buttons button {
    font-size: var(--app-font-size-mono);
    line-height: 1.4;
    padding: 0 6px;
    white-space: nowrap;
    /* マウスが乗るまでは場所だけ取って隠す（出入りで行がずれないように） */
    visibility: hidden;
  }

  /*
    行モード中はマウスを外してもボタンを出したままにする（解除する手段を隠さない）。
    コンフリクトの採用ボタンも常に出す——衝突の解消はこの画面の主目的であり、
    マウスを乗せるまで気づけない作りにはしない。
  */
  .hunk:hover .hunk-buttons button,
  .hunk:focus-within .hunk-buttons button,
  .hunk.line-mode .hunk-buttons button,
  .hunk.conflict .hunk-buttons button {
    visibility: visible;
  }

  /* 衝突の箱は、触っていなくてもひとかたまりだと分かるよう常に枠を出す */
  .hunk.conflict {
    outline-color: var(--app-text-conflict);
  }

  .hunk.conflict .hunk-header {
    color: var(--app-text-conflict);
  }

  /*
    衝突の各側。追加・削除（緑／赤）とは別の色にする——
    どちらも「消える側」ではないので、diff の色を流用すると意味を読み違える。
  */
  .line.c-ours {
    background: var(--app-conflict-ours-bg);
  }

  .line.c-theirs {
    background: var(--app-conflict-theirs-bg);
  }

  .line.c-base {
    background: var(--app-bg-raised);
  }

  .line.c-base .text {
    color: var(--app-text-muted);
  }

  .line.c-marker {
    background: var(--app-bg-raised);
  }

  .line.c-marker .text {
    color: var(--app-text-conflict);
    font-weight: 700;
  }

  .hunk-line-mode.active {
    border-color: var(--app-accent);
    color: var(--app-accent);
    font-weight: 700;
  }

  .hunk-lines {
    display: contents;
  }

  .line {
    display: flex;
    white-space: pre;
  }

  .line.added {
    background: var(--app-diff-added-bg);
  }

  .line.removed {
    background: var(--app-diff-removed-bg);
  }

  /*
    行モード中の当たり判定。枠は地色を潰さない内側の線で描くので、
    追加・削除の背景色を残したまま 4 テーマすべてで見分けられる。
  */
  .line.pickable {
    cursor: pointer;
    outline: 1px solid transparent;
    outline-offset: -1px;
  }

  .line.pickable:hover,
  .line.pickable:focus-visible {
    outline-color: var(--app-accent);
  }

  .line.pickable:hover .sign,
  .line.pickable:focus-visible .sign {
    color: var(--app-accent);
    font-weight: 700;
  }

  .no {
    flex: 0 0 auto;
    width: 46px;
    padding-right: 8px;
    text-align: right;
    color: var(--app-text-muted);
    user-select: none;
  }

  .sign {
    flex: 0 0 auto;
    width: 14px;
    text-align: center;
    user-select: none;
  }

  .line.added .sign,
  .line.added .text {
    color: var(--app-text-added);
  }

  .line.removed .sign,
  .line.removed .text {
    color: var(--app-text-removed);
  }

  .line.no-newline .text {
    color: var(--app-text-muted);
    font-style: italic;
  }
</style>
