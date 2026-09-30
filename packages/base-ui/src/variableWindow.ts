/**
 * 可変サイズの仮想化（行の高さ・列の幅がそれぞれ違うもの）。ライブラリは使わない。
 *
 * `computeWindow`（virtualList.ts）は固定行高のためのもの。表計算のグリッドのように
 * 行ごとに高さが違う（非表示の行は 0）場合は、累積和を 1 回作って二分探索で可視範囲を引く。
 * 行にも列にも同じ関数を使う。純関数なので UI フレームワークに依存しない。
 */

/** 大きさの並びから累積和を作る。長さは n + 1 で、[i] が i 番目の始まりの位置。 */
export function buildOffsets(sizes: ArrayLike<number>): Float64Array {
  const out = new Float64Array(sizes.length + 1);
  let acc = 0;
  for (let i = 0; i < sizes.length; i += 1) {
    const s = sizes[i] ?? 0;
    acc += s > 0 ? s : 0;
    out[i + 1] = acc;
  }
  return out;
}

/** 位置 `position` を含む要素の添字（0..n-1）。要素が無ければ 0。大きさ 0 の要素は飛ばす。 */
export function indexAtOffset(offsets: Float64Array, position: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  // offsets[i] <= position < offsets[i + 1] となる最大の i
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] ?? 0) <= position) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface VariableRange {
  /** 描く最初の要素。 */
  readonly start: number;
  /** 描く最後の要素の次（end は含まない）。 */
  readonly end: number;
  /** 全体の大きさ。 */
  readonly total: number;
}

/**
 * 見えている範囲（前後に overscan 個ずつ足す）。`scroll` はスクロール位置、`viewport` は見える大きさ。
 */
export function rangeAtOffset(
  offsets: Float64Array,
  scroll: number,
  viewport: number,
  overscan = 2,
): VariableRange {
  const n = offsets.length - 1;
  const total = offsets[n] ?? 0;
  if (n <= 0) return { start: 0, end: 0, total };
  const first = indexAtOffset(offsets, Math.max(0, scroll));
  const last = indexAtOffset(offsets, Math.max(0, scroll + Math.max(0, viewport) - 1));
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(n, last + 1 + overscan),
    total,
  };
}
