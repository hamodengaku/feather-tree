<script lang="ts">
  import { untrack } from 'svelte';
  import { app } from '../lib/appState.svelte.js';
  import { folderNameFromUrl, joinPreview, parentOf } from '../lib/cloneForm.js';

  let url = $state('');
  let parentDir = $state('');
  /** クローン方法。2 つは同時に選べない（片方を入れると他方が外れる。両方外すと通常のクローン）。 */
  let shallow = $state(false);
  let large = $state(false);
  /**
   * フォルダ名を自分で指定するか。切っている間は URL から補完した名前を使い、欄は触れない。
   * 入れた瞬間は補完済みの名前を初期値として引き継ぎ、そこから書き換えさせる。
   */
  let customName = $state(false);
  let typedName = $state('');

  /**
   * このクローンに使う SSH 秘密鍵（決定 9 の追記）。空なら ssh-agent 等に任せる。
   *
   * 鍵はリポジトリごとに持つ（決定 13）が、**クローンの時点ではまだリポジトリが無い**
   * ので、ここだけ入力から受け取る。成功したらそのリポジトリの設定として保存される。
   */
  let sshKeyPath = $state('');

  /**
   * URL 欄の入力が確定したか（貼り付け・ドロップ・欄から離れた）。
   * 形の分からない URL（`\\server\share\repo` 等）だけは、確定するまで補完しない（cloneForm.ts）。
   */
  let committed = $state(false);

  /**
   * URL から補完したフォルダ名。アドレス段階では空欄、パスに入ったら入力途中でも反映する
   * （規則は folderNameFromUrl）。欄の表示と送信に使う名前は常に同じ。
   */
  const autoName = $derived(folderNameFromUrl(url, committed));
  const name = $derived(customName ? typedName : autoName);

  function onUrlInput(event: Event): void {
    const kind = event instanceof InputEvent ? event.inputType : '';
    committed = kind === 'insertFromPaste' || kind === 'insertFromDrop';
  }

  /**
   * 開いた瞬間だけ初期値へ戻す。保存先はアクティブなタブのリポジトリの隣（親フォルダ）。
   * activeId / sessions を untrack するのは、開いている最中にタブが動いても入力を書き戻さないため。
   * 確認ダイアログとの行き来では cloneDialogOpen が変わらないので、入力は残る。
   */
  $effect(() => {
    if (!app.cloneDialogOpen) return;
    const root = untrack(() => app.sessions.find((s) => s.id === app.activeId)?.root ?? null);
    url = '';
    parentDir = root === null ? '' : parentOf(root);
    shallow = false;
    large = false;
    customName = false;
    typedName = '';
    committed = false;
    sshKeyPath = '';
  });

  /** 鍵を選ぶだけ（この時点では保存しない。保存はクローンが成功してから main が行う）。 */
  async function pickKey(): Promise<void> {
    const picked = await app.pickSshKeyPath();
    if (picked !== null) sshKeyPath = picked;
  }

  function onShallowChange(checked: boolean): void {
    shallow = checked;
    if (checked) large = false;
  }

  function onLargeChange(checked: boolean): void {
    large = checked;
    if (checked) shallow = false;
  }

  function onCustomNameChange(checked: boolean): void {
    customName = checked;
    if (checked) typedName = autoName;
  }

  async function browse(): Promise<void> {
    const picked = await app.pickCloneDirectory();
    if (picked !== null) parentDir = picked;
  }

  const preview = $derived(joinPreview(parentDir, name));
  const canSubmit = $derived(
    !app.busy && url.trim().length > 0 && parentDir.trim().length > 0 && name.trim().length > 0,
  );

  /** 「決定」。ここでは git を動かさず、最終確認（CloneConfirmDialog）へ進む。 */
  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (!canSubmit) return;
    const mode = large ? 'large' : shallow ? 'shallow' : 'normal';
    const key = sshKeyPath.trim();
    app.confirmClone({
      url: url.trim(),
      parentDir: parentDir.trim(),
      name: name.trim(),
      mode,
      sshKeyPath: key.length === 0 ? null : key,
    });
  }
</script>

<!--
  「リポジトリを開く」のポップアップから開く（対応表 #37 の入力）。見た目は OptionsDialog と同じ作り。
  「決定」で最終確認（CloneConfirmDialog）へ進み、実行と進捗表示はそちらが受け持つ。
  確認を出している間はこちらを隠す（入力内容はこのコンポーネントの状態として残るので、戻れば元どおり）。
-->
{#if app.cloneDialogOpen && app.cloneConfirm === null}
  <div class="backdrop" role="presentation" onclick={() => app.closeCloneDialog()}></div>
  <div class="dialog" role="dialog" aria-labelledby="clone-title">
    <h2 id="clone-title">リポジトリをクローン</h2>
    <form onsubmit={submit}>
      <label class="field">
        <span>URL</span>
        <input
          type="text"
          class="mono"
          bind:value={url}
          oninput={onUrlInput}
          onchange={() => (committed = true)}
          placeholder="git@example.com:owner/repo.git"
          spellcheck="false"
          autocomplete="off"
        />
      </label>

      <div class="field">
        <label for="clone-parent">保存先フォルダ</label>
        <div class="row">
          <input id="clone-parent" type="text" class="mono" bind:value={parentDir} spellcheck="false" autocomplete="off" />
          <button type="button" onclick={() => void browse()}>参照…</button>
        </div>
      </div>

      <!--
        フォルダ名は URL から自動で補完する。変えたいときだけチェックを入れて書き換える。
        チェック（label）を「フォルダ名」の label の中に入れ子にしないよう、ここは div にしてある。
      -->
      <div class="field">
        <label for="clone-name">フォルダ名</label>
        <input
          id="clone-name"
          type="text"
          class="mono"
          value={name}
          disabled={!customName}
          oninput={(e) => (typedName = e.currentTarget.value)}
          spellcheck="false"
          autocomplete="off"
        />
        <label class="check">
          <input
            type="checkbox"
            checked={customName}
            onchange={(e) => onCustomNameChange(e.currentTarget.checked)}
          />
          <span>フォルダ名を指定する</span>
        </label>
      </div>

      <!--
        クローン方法（決定 9）。シャローで後から履歴を戻す手順は、完了したときに確認ダイアログで出す。
      -->
      <label class="check">
        <input type="checkbox" checked={shallow} onchange={(e) => onShallowChange(e.currentTarget.checked)} />
        <span>最新コミットのみ取得（シャロークローン）</span>
      </label>
      <p class="note">タイムアウトしづらくなります</p>

      <label class="check">
        <input type="checkbox" checked={large} onchange={(e) => onLargeChange(e.currentTarget.checked)} />
        <span>大規模レポジトリをいい感じにクローンする</span>
      </label>
      <p class="note">タイムアウト対策とLFSロードを全自動で行います</p>

      <!--
        SSH 鍵（任意）。https の URL では要らないので、畳まず出しつつ「任意」と明記する。
        ここで選んだ鍵はクローンに使い、成功したらそのリポジトリの設定になる。
      -->
      <label class="field">
        <span>SSH 秘密鍵（任意）</span>
        <div class="row">
          <input
            type="text"
            class="mono"
            placeholder="自動（ssh-agent や ~/.ssh/config に準拠）"
            spellcheck="false"
            bind:value={sshKeyPath}
          />
          <button type="button" onclick={() => void pickKey()}>参照…</button>
        </div>
      </label>

      {#if preview.length > 0}
        <p class="preview mono" title={preview}>{preview} に作成します</p>
      {/if}

      <div class="actions">
        <button type="button" onclick={() => app.closeCloneDialog()}>キャンセル</button>
        <button type="submit" disabled={!canSubmit}>決定</button>
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

  .row {
    display: flex;
    gap: var(--app-metric-gap);
  }

  .row input {
    flex: 1 1 auto;
    min-width: 0;
  }

  .row button {
    flex: 0 0 auto;
  }

  .mono {
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  /* チェックボックスは横並び（.field の縦並びとは別物）。OptionsDialog と同じ。 */
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

  .note {
    margin: 0 0 14px 22px;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .preview {
    margin: 0 0 6px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--app-text-muted);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--app-metric-gap);
    margin-top: 6px;
  }
</style>
