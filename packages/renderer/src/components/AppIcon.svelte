<script lang="ts">
  /*
   * アプリのロゴ。
   *
   * 配布アイコン（build/icon.ico）と同じ素材を参照する。別に絵を持つと、
   * タスクバーに出ているアイコンと画面の中のロゴが食い違うため。
   *
   * 素材はサイズごとに人が描いたもの（build/icon/README.md）なので、縮小に頼らず
   * srcset で表示密度ごとの実寸を選ぶ。16px 表示なら 100% で 16.png、
   * 150% で 24.png、200% で 32.png がそのまま等倍で出る。
   *
   * docs/01-architecture.md 8 章「アイコンは SVG をインライン」の唯一の例外。
   */
  import icon16 from '../../../../build/icon/16.png';
  import icon24 from '../../../../build/icon/24.png';
  import icon32 from '../../../../build/icon/32.png';
  import icon64 from '../../../../build/icon/64.png';
  import icon128 from '../../../../build/icon/128.png';

  interface Props {
    /** 表示サイズ（CSS px）。素材を用意してある 16（タブ段）と 64（ようこそ画面）のみ。 */
    size?: 16 | 64;
  }

  const { size = 16 }: Props = $props();

  const large = $derived(size === 64);
  const src = $derived(large ? icon64 : icon16);
  /** 1.5x は 64 表示のときは素材が無い（96.png は作っていない）ので 2x だけにする。 */
  const srcset = $derived(
    large
      ? `${icon64} 1x, ${icon128} 2x`
      : `${icon16} 1x, ${icon24} 1.5x, ${icon32} 2x`,
  );
</script>

<!--
  装飾なので alt は空。
  タブ段では左端の掴みしろを残したいので -webkit-app-region は drag のまま
  （将来ここをメニューの入口にするならボタン化して no-drag を付ける）。
-->
<img class="app-icon" class:large {src} {srcset} width={size} height={size} alt="" />

<style>
  .app-icon {
    flex: 0 0 auto;
    /* タブ段は下揃え（タブの底辺を揃えるため）なので、アイコンだけ中央に戻す。 */
    align-self: center;
    margin: 0 6px 0 8px;
  }

  .large {
    display: block;
    margin: 0 auto 10px;
  }
</style>
