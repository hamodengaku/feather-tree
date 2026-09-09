/**
 * 固定行高の仮想化リスト。ライブラリは使わない。
 *
 * 土台としての意図: 可視範囲 + 前後バッファ分だけ DOM を作る。
 * 1 万件でも DOM ノードは 100 個以下に保てる。
 * 純関数なので UI フレームワークに依存しない（スクロール状態は呼び出し側が持つ）。
 */
export interface VirtualWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly paddingTop: number;
  readonly totalHeight: number;
}

export interface VirtualListOptions {
  readonly rowHeight: number;
  /** 可視範囲の前後に余分に描画する行数。 */
  readonly overscan?: number;
}

export function computeWindow(
  totalCount: number,
  scrollTop: number,
  viewportHeight: number,
  options: VirtualListOptions,
): VirtualWindow {
  const rowHeight = Math.max(1, options.rowHeight);
  const overscan = options.overscan ?? 8;

  const visibleRows = Math.ceil(Math.max(0, viewportHeight) / rowHeight);
  const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight);

  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(totalCount, firstVisible + visibleRows + overscan);

  return {
    startIndex,
    endIndex: Math.max(startIndex, endIndex),
    paddingTop: startIndex * rowHeight,
    totalHeight: totalCount * rowHeight,
  };
}
