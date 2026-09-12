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
  import icon256 from '../../../../build/icon/256.png';

  interface Props {
    /**
     * 表示サイズ（CSS px）。素材を用意してある 16（タブ段）・64（ようこそ画面）・
     * 128（スプラッシュ）のみ。
     */
    size?: 16 | 64 | 128;
  }

  const { size = 16 }: Props = $props();

  /**
   * 表示サイズごとの 1x / 2x の素材。
   * 1.5x は 16 表示のときだけ素材がある（96.png と 192.png は作っていない）。
   */
  const SOURCES = {
    16: { src: icon16, srcset: `${icon16} 1x, ${icon24} 1.5x, ${icon32} 2x` },
    64: { src: icon64, srcset: `${icon64} 1x, ${icon128} 2x` },
    128: { src: icon128, srcset: `${icon128} 1x, ${icon256} 2x` },
  } as const;

  const large = $derived(size !== 16);
  const src = $derived(SOURCES[size].src);
  const srcset = $derived(SOURCES[size].srcset);
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
