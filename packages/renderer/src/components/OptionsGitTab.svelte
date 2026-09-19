<script lang="ts">
  import { app } from '../lib/appState.svelte.js';

  /*
   * git.exe のパス（決定 7）。
   *
   * 入力中の値はローカルに持ち、確定（Enter / フォーカスを外す / 参照ボタン）で保存する。
   * 1 文字打つたびに保存すると、そのたびに main が git を解決し直すことになる。
   */
  let gitPathDraft = $state('');
  let editingGitPath = $state(false);

  const savedGitPath = $derived(app.settings?.gitPath ?? '');
  /** 編集中はその文字を、そうでなければ保存済みの値を映す。 */
  const gitPathValue = $derived(editingGitPath ? gitPathDraft : savedGitPath);

  function commitGitPath(): void {
    editingGitPath = false;
    const next = gitPathDraft.trim();
    // 空欄は「自動探索に戻す」と同じ意味にする（null）
    const value = next.length === 0 ? null : next;
    if (value === (app.settings?.gitPath ?? null)) return;
    void app.setGitPath(value);
  }

  function onGitPathKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      editingGitPath = false;
    }
  }

  /* ------------------------------------------------ コミット情報（対応表 #42〜#44） */

  const session = $derived(app.sessions.find((s) => s.id === app.activeId) ?? null);

  /*
   * 読み込みのきっかけは「この Git タブが表示された」と「対象のタブが変わった」の 2 つ。
   * この部品は Git タブを選んでいる間しか存在しないので、載ったときに 1 回読めばよい
   * （＝ダイアログを開いただけでは git を走らせない。環境タブしか見ない人に負担を掛けない）。
   */
  $effect(() => {
    void app.activeId;
    void app.loadGitIdentity();
  });

  /** 入力中の値。null は「まだ読み込んだ値で初期化していない」。 */
  let nameDraft = $state<string | null>(null);
  let emailDraft = $state<string | null>(null);
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle');
  let savedTimer: ReturnType<typeof setTimeout> | null = null;

  /*
   * 読み込み直したら入力欄を作り直す（対象のリポジトリが変わったのに前のリポジトリの
   * 打ちかけが残っていると、そのまま保存して別のリポジトリの設定を書いてしまう）。
   *
   * **ここで saveState に触らないこと。** 保存が成功すると gitIdentity が進むので、
   * この効果は保存直後にも走る。ここで idle に戻すと「保存しました」が出た次の瞬間に消える。
   */
  $effect(() => {
    const identity = app.gitIdentity;
    nameDraft = identity?.name.value ?? '';
    emailDraft = identity?.email.value ?? '';
  });

  /** 対象のリポジトリが変わったら、前のリポジトリの「保存しました」を消す。 */
  $effect(() => {
    void app.activeId;
    saveState = 'idle';
  });

  /** 開いたまま閉じられても、後から状態を触らない。 */
  $effect(() => () => {
    if (savedTimer !== null) clearTimeout(savedTimer);
  });

  const nameValue = $derived(nameDraft ?? '');
  const emailValue = $derived(emailDraft ?? '');

  /**
   * 保存できるか。**core の validateIdentityValue と同じ規則の写し**
   * （renderer は core を参照できない層構造のため）。正本は main 側で、
   * ここを通り抜けても main が同じ理由で拒否する。
   */
  function invalidReason(label: string, value: string): string | null {
    const text = value.trim();
    if (text.length === 0) return label + 'を入力してください。';
    if (text.length > 255) return label + 'が長すぎます（255 文字まで）。';
    if (text.startsWith('-')) return label + 'を「-」で始めることはできません。';
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return label + 'に改行などの制御文字は使えません。';
    }
    return null;
  }

  const nameError = $derived(invalidReason('名前', nameValue));
  const emailError = $derived(invalidReason('メールアドレス', emailValue));

  /** 保存済みの値と違うか（両方同じなら git を動かす必要が無い）。 */
  const dirty = $derived.by((): boolean => {
    const identity = app.gitIdentity;
    if (identity === null) return false;
    const same = (field: { value: string | null; scope: string }, text: string): boolean =>
      field.scope === 'local' && field.value === text.trim();
    return !same(identity.name, nameValue) || !same(identity.email, emailValue);
  });

  const canSave = $derived(
    session !== null && dirty && nameError === null && emailError === null && saveState !== 'saving',
  );

  /** 全体設定から来ている項目がある＝保存するまでこのリポジトリ固有の設定は無い。 */
  const inherited = $derived.by((): boolean => {
    const identity = app.gitIdentity;
    if (identity === null) return false;
    return identity.name.scope === 'inherited' || identity.email.scope === 'inherited';
  });

  const unset = $derived.by((): boolean => {
    const identity = app.gitIdentity;
    if (identity === null) return false;
    return identity.name.scope === 'unset' || identity.email.scope === 'unset';
  });

  async function save(): Promise<void> {
    if (!canSave) return;
    saveState = 'saving';
    const done = await app.saveGitIdentity(nameValue.trim(), emailValue.trim());
    saveState = done ? 'saved' : 'idle';
    if (!done) return;
    if (savedTimer !== null) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      saveState = 'idle';
      savedTimer = null;
    }, 2000);
  }
</script>

<div class="block">
  <h3 class="block-title">git.exe のパス</h3>
  <p class="note">
    FeatherTreeで使用する git を指定できます。
  </p>

  <div class="row">
    <input
      type="text"
      class="path"
      placeholder="自動"
      spellcheck="false"
      value={gitPathValue}
      oninput={(e) => {
        editingGitPath = true;
        gitPathDraft = e.currentTarget.value;
      }}
      onblur={commitGitPath}
      onkeydown={onGitPathKeydown}
    />
    <button onclick={() => void app.pickGitExecutable()}>参照…</button>
    <button onclick={() => void app.setGitPath(null)} disabled={savedGitPath.length === 0}>
      自動に戻す
    </button>
  </div>

  <!-- 指定が効いているかは「今どの git を使っているか」でしか確かめられないので、必ず出す。 -->
  <dl class="detected">
    <dt>現在の指定</dt>
    <dd>{app.environment?.gitPath ?? '見つかっていません'}</dd>
    <dt>バージョン</dt>
    <dd>{app.environment?.gitVersion ?? '—'}</dd>
  </dl>

  {#if app.environment?.warning != null}
    <p class="warning">{app.environment.warning}</p>
  {/if}
</div>

<!--
  コミット情報（対応表 #42〜#44）。
  **この画面で唯一、ユーザーの git の設定ファイルを書き換える項目**なので、
  ほかの設定と違って明示の保存ボタンを置く（決定 13 の追記）。
-->
<div class="block">
  <div class="block-head">
    <h3 class="block-title">コミット情報</h3>
    {#if session !== null}
      <span class="target" title={session.root}>対象: {session.displayName}</span>
    {/if}
  </div>

  {#if session === null}
    <p class="note">
      対象のリポジトリがありません。リポジトリを開くと、そのリポジトリのコミット情報を編集できます。
    </p>
  {:else if app.gitIdentityLoading && app.gitIdentity === null}
    <p class="note">読み込み中…</p>
  {:else}
    {#if inherited}
      <p class="warning">
        <strong>全体設定（git の global）</strong>が使われています。
        個別設定を行う場合は、記入してください（全体設定は変わりません）。
      </p>
    {:else if unset}
      <p class="warning">
        名前とメールアドレスを登録してください。
      </p>
    {/if}

    <label class="field">
      <span>名前</span>
      <input
        type="text"
        value={nameValue}
        spellcheck="false"
        oninput={(e) => (nameDraft = e.currentTarget.value)}
      />
    </label>
    {#if nameError !== null}
      <p class="field-error">{nameError}</p>
    {/if}

    <label class="field">
      <span>メールアドレス</span>
      <input
        type="text"
        value={emailValue}
        spellcheck="false"
        oninput={(e) => (emailDraft = e.currentTarget.value)}
      />
    </label>
    {#if emailError !== null}
      <p class="field-error">{emailError}</p>
    {/if}

    <div class="row">
      <button onclick={() => void save()} disabled={!canSave}>
        {saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '保存しました' : '保存'}
      </button>
    </div>

    <p class="note">
      本項目は <code>.git/config</code> を書き換えます。
      保存を押すまで反映されません。全体設定（global）は変更しません。
    </p>
    <!--
      空欄にして消したい人への逃げ道。アプリからは --unset しない
      （ローカルを消すと全体設定の値に黙って戻るため。決定 13 の追記）。
    -->
    <p class="note">
      ※全体設定に戻す（個別設定を消す）には、ターミナルで
      <code>git config --local --unset user.name</code> を実行してください。
    </p>
  {/if}
</div>

<style>
  /*
    ごく薄い座布団。環境タブの .group と同じ考え方で、線ではなく面でまとまりを示す
    （色は raised トークンなので、どのテーマでもダイアログの面から一段持ち上がる）。
  */
  .block {
    margin-bottom: 14px;
    padding: 10px 12px;
    border-radius: var(--app-metric-radius);
    background: var(--app-bg-raised);
  }

  /* 座布団の下端に余分な余白を残さない（残すと上下の padding が非対称に見える）。 */
  .block > :last-child {
    margin-bottom: 0;
  }

  .block-title {
    margin: 0 0 8px;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
    color: var(--app-text-secondary);
  }

  /* 見出しの右に対象リポジトリを添える。どこに書き込むのかを常に見せるため。 */
  .block-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--app-metric-gap);
  }

  .target {
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
    overflow-wrap: anywhere;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
    color: var(--app-text-secondary);
  }

  .field input {
    max-width: 420px;
  }

  .field-error {
    margin: -6px 0 10px;
    color: var(--app-text-danger);
    font-size: var(--app-font-size-mono);
  }

  .note code {
    font-family: var(--app-font-mono);
  }

  .note {
    margin: 0 0 10px;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--app-metric-gap);
    margin-bottom: 10px;
  }

  .path {
    flex: 1;
    min-width: 0;
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
  }

  /* 検出結果は「項目名 → 値」の 2 列。値は長いパスが入るので折り返させる。 */
  .detected {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 12px;
    margin: 0;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .detected dt {
    color: var(--app-text-secondary);
  }

  .detected dd {
    margin: 0;
    font-family: var(--app-font-mono);
    overflow-wrap: anywhere;
  }

  .warning {
    margin: 10px 0 0;
    color: var(--app-text-conflict);
    font-size: var(--app-font-size-mono);
  }
</style>
