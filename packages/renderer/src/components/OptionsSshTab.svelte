<script lang="ts">
  import { app } from '../lib/appState.svelte.js';

  /*
   * SSH 秘密鍵のパス（決定 13 の追記）。
   *
   * 入力中の値はローカルに持ち、確定（Enter / フォーカスを外す / 参照ボタン）で保存する。
   * 保存しても git は動かない。次に git を実行するときから効く。
   */
  let draft = $state('');
  let editing = $state(false);

  /** 鍵はリポジトリごと（決定 13 の 2026-09-19 改定 2）。対象はアクティブなタブ。 */
  const session = $derived(app.sessions.find((s) => s.id === app.activeId) ?? null);
  const saved = $derived(app.sshKeyPath ?? '');
  const value = $derived(editing ? draft : saved);

  /* 対象のリポジトリが変わったら打ちかけを捨てる（別のリポジトリに書いてしまわないように）。 */
  $effect(() => {
    void app.activeId;
    editing = false;
    draft = '';
  });

  /**
   * 実際に git へ渡す値。core の buildSshCommand と同じ規則で組み立てる。
   *
   * renderer は core を参照できない層構造なので、表示用にここで組み直している。
   * **正本は `packages/core/src/env/sshCommand.ts`**（そちらの結果が実際に git へ渡る）。
   * ここはあくまで「何が渡るか」を見せるための写し。
   */
  const quote = (path: string): string =>
    "'" + path.split('\\').join('/').split("'").join("'\\''") + "'";

  const injected = $derived.by((): string | null => {
    const ssh = app.environment?.sshPath ?? null;
    if (saved.length === 0 || ssh === null) return null;
    // ssh も鍵も絶対パスで引用する（bare 名は渡さない。診断 1-A）
    return quote(ssh) + ' -i ' + quote(saved) + ' -o IdentitiesOnly=yes';
  });

  /** 鍵は登録されているのに ssh が見つかっていない＝何も注入されない。黙って効かないので知らせる。 */
  const sshMissing = $derived(saved.length > 0 && (app.environment?.sshPath ?? null) === null);

  /** 公開鍵を選んでしまう取り違えはよくあるので、警告だけ出す（保存は妨げない）。 */
  const looksPublic = $derived(saved.toLowerCase().endsWith('.pub'));

  function commit(): void {
    editing = false;
    const next = draft.trim();
    const value = next.length === 0 ? null : next;
    if (value === (app.sshKeyPath ?? null)) return;
    void app.setSshKeyPath(value);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      editing = false;
    }
  }
</script>

<div class="block">
  <div class="block-head">
    <h3 class="block-title">SSH 秘密鍵</h3>
    {#if session !== null}
      <span class="target" title={session.root}>対象: {session.displayName}</span>
    {/if}
  </div>
  <p class="note">
    FeatherTreeが使用するSSH秘密鍵を、<strong>このリポジトリについて</strong>指定できます。
    秘密鍵（.pubではない方）を選んでください。
  </p>

  {#if session === null}
    <p class="note">
      対象のリポジトリがありません。リポジトリを開くと、そのリポジトリで使う鍵を指定できます。
      クローンする前に鍵が要る場合は、クローンの入力欄で指定してください。
    </p>
  {:else}
  <div class="row">
    <input
      type="text"
      class="path"
      placeholder="自動（ssh-agent や <code>~/.ssh/config</code>に準拠）"
      spellcheck="false"
      {value}
      oninput={(e) => {
        editing = true;
        draft = e.currentTarget.value;
      }}
      onblur={commit}
      onkeydown={onKeydown}
    />
    <button onclick={() => void app.pickSshKey()}>参照…</button>
    <button onclick={() => void app.setSshKeyPath(null)} disabled={saved.length === 0}>
      使わない
    </button>
  </div>

  {#if looksPublic}
    <p class="warning">
      公開鍵（.pub）が選ばれています。通信に使うのは<strong>秘密鍵</strong>（同名で .pub が付かない方）です。
    </p>
  {/if}

  <!--
    何が git に渡るかをそのまま見せる（透明性）。引用の付き方で通る・通らないが変わるので、
    「指定したのに効かない」ときに、ここを読めば原因の当たりが付く。
  -->
  {#if sshMissing}
    <p class="warning">
      ssh が見つからないため、この鍵は使われません。Git for Windows か Windows の OpenSSH を
      導入するか、ssh のあるフォルダを PATH に通してアプリを再起動してください。
    </p>
  {/if}

  {#if injected !== null}
    <div class="injected">
      <span class="injected-label">git に渡す値</span>
      <code>GIT_SSH_COMMAND={injected}</code>
    </div>
  {/if}

  <p class="note scope">
    本項はグローバル設定を上書きしません。
    ※<code>-o IdentitiesOnly=yes</code> オプションは、ssh-agent に鍵が多数登録されている環境で
    「認証の試行回数が上限を超えました」を避けるためです。
  </p>
  {/if}
</div>

<style>
  .block-title {
    margin: 0 0 8px;
    font-size: var(--app-font-size-ui);
    font-weight: 600;
    color: var(--app-text-secondary);
  }

  /* 見出しの右に対象リポジトリを添える。どこに効く設定かを常に見せるため（Git タブと同じ）。 */
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

  .note {
    margin: 0 0 10px;
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
    line-height: 1.6;
  }

  .note code {
    font-family: var(--app-font-mono);
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

  .warning {
    margin: 0 0 10px;
    color: var(--app-text-conflict);
    font-size: var(--app-font-size-mono);
  }

  .injected {
    margin-bottom: 12px;
    padding: 8px 10px;
    background: var(--app-bg-raised);
    border: 1px solid var(--app-border-subtle);
    border-radius: var(--app-metric-radius);
  }

  .injected-label {
    display: block;
    margin-bottom: 4px;
    color: var(--app-text-secondary);
    font-size: var(--app-font-size-mono);
  }

  .injected code {
    color: var(--app-text-primary);
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    overflow-wrap: anywhere;
  }

  .scope {
    margin-bottom: 0;
    padding-top: 10px;
    border-top: 1px solid var(--app-border-subtle);
  }
</style>
