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

/**
 * 描画範囲 `[startIndex, endIndex)` の中で、最初に未取得（undefined）の位置を返す。全て取得済みなら null。
 *
 * 範囲の先頭だけを見ると、取得済みの行が先頭に残っている間は後ろの未取得行が
 * 「読み込み中…」のまま取りに行かれず、画面が未取得行で埋まるまで読み込みが再開しない。
 */
export function firstMissingIndex(
  entries: readonly unknown[],
  window: Pick<VirtualWindow, 'startIndex' | 'endIndex'>,
): number | null {
  for (let i = window.startIndex; i < window.endIndex; i++) {
    if (entries[i] === undefined) return i;
  }
  return null;
}
