<script lang="ts">
  /*
   * Unity Prefab 差分モードの右側（決定 32）。
   *
   * 中を左右に 2 分割し、左＝ヒエラルキー／右＝プロパティ表を置く器。
   * 「展開できない」系の案内もここが出す——どの状態でも**必ず何か出る**ようにして、
   * 白い画面に落ちないようにする。
   *
   * 差分ペイン（DiffPane）とは別物で、行の diff は一切出さない。
   * Prefab ではないファイルを選んだときも通常の diff へは倒さず、案内だけを出す（要件 5）。
   */
  import PaneSplitter from '../components/PaneSplitter.svelte';
  import UnityHierarchyPane from './UnityHierarchyPane.svelte';
  import UnityPropertyPane from './UnityPropertyPane.svelte';
  import { app } from '../lib/appState.svelte.js';

  let liveWidth = $state<number | null>(null);
  const width = $derived(liveWidth ?? app.settings?.unityHierarchyWidth ?? 320);

  const view = $derived(app.unityView);
  const selected = $derived(app.selected);

  /*
   * モードに入った瞬間・選んだファイルが変わった瞬間に取りに行く。
   * ここが唯一の入口なので、**差分モードでいる限り #48 も diff も 1 度も走らない**
   * （コミットログモードが ensureLog を持っているのと同じ形）。
   */
  $effect(() => {
    // 依存を明示するために読む（選択が変わったら取り直す）
    void selected?.path;
    void selected?.staged;
    void app.ensureUnity();
  });

  /** ステージできない理由を日本語にする。**黙ってボタンを消さない**（F-5）。 */
  function refusalText(refusal: string | null): string {
    switch (refusal) {
      case 'truncated':
        return '変更が大きすぎるため（20 万行超）、ファイル単位でのみステージできます。';
      case 'synthesized':
        return '新規ファイルなので、ファイル単位でステージしてください。';
      case 'whole-file':
        return 'ファイル全体の追加・削除なので、ファイル単位でステージしてください。';
      case 'rename':
        return 'リネームを含むため、ファイル単位でのみステージできます。';
      case 'combined':
        return 'マージの衝突中はここからステージできません。';
      case 'alignment':
        return '改行変換または LFS フィルタが入っているため、パラメータ単位のステージができません（表示は可能です）。';
      case 'no-diff':
      case 'no-hunk':
        return '';
      default:
        return refusal === null ? '' : 'この差分はパラメータ単位でステージできません。';
    }
  }

  const notice = $derived(view === null ? '' : refusalText(view.refusal));
</script>

<section class="unity-pane" aria-label="Unity Prefab 差分">
  {#if selected === null}
    <p class="empty">ファイルを選択すると Prefab の中身を表示します。</p>
  {:else if app.unityLoading && view === null}
    <p class="empty">読み込み中…</p>
  {:else if app.unityError !== null}
    <p class="empty error">{app.unityError.message}</p>
  {:else if view === null}
    <p class="empty">読み込み中…</p>
  {:else if view.format === 'not-prefab'}
    <p class="empty">Prefab ではありません。差分は差分モードで確認してください。</p>
  {:else if view.format === 'binary'}
    <p class="empty">バイナリ形式のため展開できません。</p>
  {:else if view.nodes.length === 0}
    <p class="empty">表示できるゲームオブジェクトがありません。</p>
  {:else}
    {#if notice !== ''}
      <p class="notice">{notice}</p>
    {/if}
    <!--
      読み込み直し（ステージの直後など）の間も、前の中身を出したまま帯だけ出す。
      消してから出し直すとヒエラルキーのスクロールが毎回先頭へ戻る。
    -->
    {#if app.unityLoading}
      <p class="notice">読み込み中…</p>
    {/if}
    <div class="split" style:grid-template-columns="{width}px 6px minmax(240px, 1fr)">
      <UnityHierarchyPane />
      <PaneSplitter
        value={width}
        min={160}
        max={1200}
        onchange={(w) => (liveWidth = w)}
        oncommit={(w) => {
          liveWidth = null;
          void app.setUnityHierarchyWidth(w);
        }}
      />
      <UnityPropertyPane />
    </div>
  {/if}
</section>

<style>
  .unity-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--app-bg-base);
  }

  .split {
    flex: 1 1 auto;
    display: grid;
    min-width: 0;
    min-height: 0;
  }

  .empty {
    margin: 0;
    padding: 12px;
    color: var(--app-text-secondary);
    font-size: var(--app-font-size-ui);
  }

  .empty.error {
    color: var(--app-text-danger);
  }

  /* 理由の帯。ペインを塞がず、ヒエラルキーの上に 1 行だけ置く。 */
  .notice {
    flex: 0 0 auto;
    margin: 0;
    padding: 4px 12px;
    border-bottom: 1px solid var(--app-border-subtle);
    background: var(--app-bg-raised);
    color: var(--app-text-secondary);
    font-size: var(--app-font-size-ui);
  }
</style>
