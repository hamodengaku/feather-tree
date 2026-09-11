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

/**
 * ステージ／アンステージの直後に選ぶべきファイル。
 *
 * 操作したファイルが一覧から消えるので、その 1 行下（無ければ 1 行上）へ移す。
 * これで連続してステージするときにマウスを動かし直さずに済む。
 *
 * @param entries 操作**前**の一覧。仮想化リストの未取得ぶんは undefined が入る（疎配列）。
 * @param removed 操作したパス。
 * @returns 次に選ぶパス。候補が無ければ null（選択解除）。
 */
export function nextSelectionAfterRemoval(
  entries: readonly (FileEntryDto | undefined)[],
  removedPaths: readonly string[],
): string | null {
  const removed = new Set(removedPaths);
  const indices: number[] = [];
  entries.forEach((entry, i) => {
    if (entry !== undefined && removed.has(entry.path)) indices.push(i);
  });
  if (indices.length === 0) return null;

  const last = Math.max(...indices);
  for (let i = last + 1; i < entries.length; i += 1) {
    const path = entries[i]?.path;
    // 未取得の穴は飛ばす（パスが分からないので選べない）
    if (path !== undefined && !removed.has(path)) return path;
  }

  const first = Math.min(...indices);
  for (let i = first - 1; i >= 0; i -= 1) {
    const path = entries[i]?.path;
    if (path !== undefined && !removed.has(path)) return path;
  }

  return null;
}
