import type { FileEntryDto } from '@feathertree/ipc';

/**
 * ファイル一覧1セクション分の複数選択状態。
 * ステージ済み／変更は別々に持つ（セクションを跨いだ選択はしない）。
 */
export interface SelectionState {
  readonly selected: ReadonlySet<string>;
  readonly anchorIndex: number | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchorIndex: null };

export interface ClickInfo {
  readonly index: number;
  readonly path: string;
  /** event.ctrlKey || event.metaKey を渡す。 */
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * Windows標準の Ctrl / Shift クリック選択規則。
 * - 修飾キー無し: そのファイルだけの単独選択に置き換え、アンカーを更新する
 * - Ctrl/Cmd: そのファイルだけをトグルし、アンカーを更新する
 * - Shift: アンカー〜クリック位置の連続範囲を選択する（アンカーは変えない）。
 *   アンカーが無ければ単独選択と同じ扱いにする。
 *   範囲内に未ロードのエントリ（仮想化リストがまだ取得していない行）があれば、そのインデックスは
 *   選択対象から除外する（パスが分からないので選択できない）。
 */
export function nextSelection(
  state: SelectionState,
  click: ClickInfo,
  entries: readonly (FileEntryDto | undefined)[],
): SelectionState {
  if (click.shiftKey && state.anchorIndex !== null) {
    const from = Math.min(state.anchorIndex, click.index);
    const to = Math.max(state.anchorIndex, click.index);
    const next = new Set<string>();
    for (let i = from; i <= to; i += 1) {
      const path = entries[i]?.path;
      if (path !== undefined) next.add(path);
    }
    return { selected: next, anchorIndex: state.anchorIndex };
  }

  if (click.ctrlKey) {
    const next = new Set(state.selected);
    if (next.has(click.path)) next.delete(click.path);
    else next.add(click.path);
    return { selected: next, anchorIndex: click.index };
  }

  return { selected: new Set([click.path]), anchorIndex: click.index };
}
