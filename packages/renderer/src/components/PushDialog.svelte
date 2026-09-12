<script lang="ts">
  /*
   * プッシュのダイアログ（対応表 #24 / #25）。
   *
   * 選ぶものは「どのブランチを」「どのリモートへ」の 2 つと、上流を設定するかどうか。
   * ただし後ろの 2 つは既定で畳んでおく。**ほとんどの場合それでよい**からで、
   * 行き先は畳んだままでも下の 1 行（summary）に必ず出る。
   * 強制プッシュ（#26）はここに無い。確認ダイアログを伴うので別物として足すこと。
   *
   * 失敗してもダイアログは閉じない（エラーは App.svelte のエラー帯に出る）。
   * 条件を変えてすぐ試し直せるほうが、閉じて開き直すより早い。CreateBranchDialog と同じ方針。
   */
  import { untrack } from 'svelte';
  import type { BranchDto } from '@feathertree/ipc';
  import { app } from '../lib/appState.svelte.js';

  let branch = $state('');
  let remote = $state('');
  let setUpstream = $state(false);
  /** 「リモートと上流」の折り畳み。開くたびに畳んだ状態へ戻す。 */
  let detailsOpen = $state(false);

  const locals = $derived(app.branches.filter((b) => !b.isRemote));
  const selected = $derived(locals.find((b) => b.shortName === branch) ?? null);

  /** 上流「origin/main」からリモート名だけを取り出す。 */
  function remoteOf(upstream: string | null): string | null {
    if (upstream === null) return null;
    const slash = upstream.indexOf('/');
    return slash === -1 ? null : upstream.slice(0, slash);
  }

  /** 今選んでいるリモートが、そのブランチの上流と一致しているか。 */
  const tracking = $derived(selected !== null && remoteOf(selected.upstream) === remote);

  /**
   * 押しても git が何もしない状態。上流が合っていて、進んでもおらず、上流も生きている。
   * ボタンを押せなくしたうえで、下の 1 行でなぜかを言う。
   */
  const nothingToPush = $derived(
    selected !== null && tracking && !selected.gone && selected.ahead === 0,
  );

  const canSubmit = $derived(
    !app.busy && selected !== null && remote.length > 0 && !nothingToPush,
  );

  /** 今の選択で何が起きるかの 1 行。押す前に結果が読めるようにする。 */
  const summary = $derived.by(() => {
    if (selected === null) return '';
    const target = remote + '/' + selected.shortName;
    if (nothingToPush) return target + ' と同じ位置です。送るコミットはありません。';
    if (selected.gone) return target + ' は削除されています。プッシュすると作り直されます。';
    if (!tracking) {
      const suffix = setUpstream ? '（上流として設定します）' : '（上流は設定しません）';
      return target + ' へ送ります' + suffix;
    }
    return String(selected.ahead) + ' 個のコミットを ' + target + ' へ送ります。';
  });

  /** 一覧の見出し。ahead と上流をその場で読めるようにしておく。 */
  function branchLabel(b: BranchDto): string {
    const ahead = b.ahead > 0 ? ' ↑' + String(b.ahead) : '';
    if (b.upstream === null) return b.shortName + '（上流なし）' + ahead;
    if (b.gone) return b.shortName + ' → ' + b.upstream + '（削除済み）';
    return b.shortName + ' → ' + b.upstream + ahead;
  }

  /**
   * ブランチを選び直したら、行き先もそのブランチの上流に合わせ直す。
   * 上流が無ければ先頭のリモートへ向け、上流の設定にチェックを入れておく
   * （git の push.autoSetupRemote と同じ既定。外すこともできる）。
   */
  function alignTo(shortName: string): void {
    branch = shortName;
    const found = locals.find((b) => b.shortName === shortName) ?? null;
    const upstream = remoteOf(found?.upstream ?? null);
    remote = upstream ?? app.remotes[0] ?? '';
    setUpstream = upstream === null;
  }

  /*
   * 開いた瞬間だけ今いるブランチに合わせる。
   * untrack するのは、開いている最中に status が更新されても選択を戻さないため
   * （CreateBranchDialog と同じ）。
   */
  $effect(() => {
    if (!app.pushDialogOpen) return;
    const current = untrack(() => app.currentBranch);
    const fallback = untrack(() => app.branches).find((b) => !b.isRemote)?.shortName ?? '';
    untrack(() => alignTo(current ?? fallback));
    detailsOpen = false;
  });

  /** 上流が既に合っているときは設定し直す意味が無いので、チェック自体を押させない。 */
  const upstreamLocked = $derived(tracking);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit || selected === null) return;
    await app.push(remote, selected.shortName, setUpstream && !upstreamLocked, () =>
      app.closePushDialog(),
    );
  }
</script>

{#if app.pushDialogOpen}
  <div class="backdrop" role="presentation" onclick={() => app.closePushDialog()}></div>
  <div class="dialog" role="dialog" aria-labelledby="push-title">
    <h2 id="push-title">プッシュ</h2>
    <form onsubmit={submit}>
      <label class="field">
        <span>ブランチ</span>
        <select value={branch} onchange={(e) => alignTo(e.currentTarget.value)}>
          {#each locals as b (b.shortName)}
            <option value={b.shortName}>{branchLabel(b)}</option>
          {/each}
        </select>
      </label>

      <!--
        既定の行き先で困らないのが普通なので畳んでおく。
        畳んでいても値は状態に残るため、開かずに送っても中身は同じ。
      -->
      <button
        type="button"
        class="disclosure"
        aria-expanded={detailsOpen}
        onclick={() => (detailsOpen = !detailsOpen)}
      >
        <span class="twisty">{detailsOpen ? '▼' : '▶'}</span>
        <span>リモートと上流の設定</span>
      </button>

      {#if detailsOpen}
        <div class="details">
          <label class="field">
            <span>リモート</span>
            <select bind:value={remote}>
              {#each app.remotes as name (name)}
                <option value={name}>{name}</option>
              {/each}
            </select>
          </label>

          <label class="check">
            <input type="checkbox" bind:checked={setUpstream} disabled={upstreamLocked} />
            <span>このリモートを上流として設定する（--set-upstream）</span>
          </label>
        </div>
      {/if}

      <p class="summary" class:blocked={nothingToPush}>{summary}</p>

      <div class="actions">
        <button type="button" onclick={() => app.closePushDialog()}>キャンセル</button>
        <button type="submit" disabled={!canSubmit}>プッシュ</button>
      </div>
    </form>
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
    width: min(440px, 90vw);
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

  /* ブランチペインのフォルダ行と同じ開閉の見た目にする（アプリ内で作法を揃える）。 */
  .disclosure {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    padding: 4px 0;
    background: none;
    border: none;
    border-radius: 0;
    color: var(--app-text-secondary);
    text-align: left;
  }

  .disclosure:hover {
    color: var(--app-text-primary);
    background: none;
  }

  .disclosure:focus-visible {
    outline: 1px solid var(--app-accent);
    outline-offset: -1px;
  }

  /* U+25B6 / U+25BC は字面いっぱいの三角なので、この行高なら 9px で十分に見える。 */
  .twisty {
    flex: 0 0 auto;
    width: 12px;
    color: var(--app-text-muted);
    font-size: 9px;
    line-height: 1;
  }

  .details {
    padding: 8px 0 0 17px;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    color: var(--app-text-secondary);
  }

  .check input:disabled + span {
    opacity: 0.45;
  }

  /* 押す前に結果を読ませる 1 行。押せない理由もここに出る。 */
  .summary {
    margin: 10px 0 6px;
    min-height: 1.5em;
    color: var(--app-text-secondary);
    font-size: var(--app-font-size-mono);
    line-height: 1.5;
  }

  .summary.blocked {
    color: var(--app-text-muted);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--app-metric-gap);
    margin-top: 6px;
  }
</style>
