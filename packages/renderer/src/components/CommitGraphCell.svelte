<script lang="ts">
  /*
   * コミットリスト 1 行分のグラフ（決定 20）。
   *
   * レーンの割り当ては lib/commitGraph.ts（純関数）が済ませてあり、ここは描くだけ。
   * 行は仮想化されていて上下の行が DOM に無いこともあるため、**1 行だけで閉じた絵**にする。
   * 線は必ず行の上辺から下辺まで（または丸まで）引き、隣の行と端で繋がって見えるようにする。
   */
  import type { GraphRow } from '../lib/commitGraph.js';

  interface Props {
    row: GraphRow;
    /** 行の高さ（px）。VirtualCommitList の ROW_HEIGHT と必ず同じ値。 */
    height: number;
    /** リスト全体で揃えるレーン数。行ごとに変えると丸の位置が左右にぶれる。 */
    lanes: number;
  }

  const { row, height, lanes }: Props = $props();

  /** レーン 1 本あたりの横幅。丸（半径 3.5px）が隣と触れない最小限。 */
  const LANE_WIDTH = 12;

  const width = $derived(Math.max(1, lanes) * LANE_WIDTH);
  const cx = $derived(row.lane * LANE_WIDTH + LANE_WIDTH / 2);
  const cy = $derived(height / 2);

  function laneX(lane: number): number {
    return lane * LANE_WIDTH + LANE_WIDTH / 2;
  }

  /**
   * 線 1 本のパス。
   *
   * 端が null なら丸の中心。上辺・下辺と丸を結ぶときは、行の中ほどまで真っ直ぐ降ろしてから
   * 斜めに寄せる（一気に斜めに引くと、レーンが増えたとき線が寝すぎて追えなくなる）。
   */
  function pathOf(top: number | null, bottom: number | null): string {
    const x1 = top === null ? cx : laneX(top);
    const y1 = top === null ? cy : 0;
    const x2 = bottom === null ? cx : laneX(bottom);
    const y2 = bottom === null ? cy : height;

    if (x1 === x2) return `M ${String(x1)} ${String(y1)} L ${String(x2)} ${String(y2)}`;
    // 3 次ベジェで S 字に曲げる。制御点を垂直に置くと、端が必ず垂直に接する
    const my = (y1 + y2) / 2;
    return `M ${String(x1)} ${String(y1)} C ${String(x1)} ${String(my)}, ${String(x2)} ${String(my)}, ${String(x2)} ${String(y2)}`;
  }

  /**
   * レーンごとの色。--app-graph-lane-N は tokens.css で 6 本ぶん定義してあり、
   * それを超えたら先頭へ戻す（レーンが 7 本以上あっても隣り合わなければ混同しない）。
   */
  function laneColor(lane: number): string {
    return `var(--app-graph-lane-${String(lane % 6)})`;
  }
</script>

<svg class="graph" {width} {height} viewBox="0 0 {width} {height}" aria-hidden="true">
  {#each row.lines as line, i (i)}
    <path
      d={pathOf(line.top, line.bottom)}
      fill="none"
      stroke={laneColor(line.top ?? line.bottom ?? row.lane)}
      stroke-width="1.5"
    />
  {/each}
  <circle {cx} {cy} r="3.5" fill={laneColor(row.lane)} />
</svg>

<style>
  .graph {
    flex: 0 0 auto;
    display: block;
    overflow: visible;
  }
</style>
