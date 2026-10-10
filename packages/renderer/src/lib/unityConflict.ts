/*
 * Unity モードの未マージ表示と GameObject 単位の解消（2026-10-10、利用者の指示）。**純関数だけ。**
 *
 * 採用側の決め方は main（unity 層の `resolvedSide`）と同じ規則にする:
 *   - 選ぶ必要のある単位（`units`）に属するノード … 利用者の選択（未選択なら null）
 *   - それ以外で両側が違うノード               … 自動で決まった側（`auto`）
 *   - 両側が同じノード                         … null（強調も斜線も無い）
 *
 * 決まるまでは自分側と相手側を対等に出す（斜線を引かない）。決まったら棄却側に斜線、採用側を強調する。
 */
import type { UnityConflictDto, UnityConflictEntryDto, UnityConflictSideDto } from '@feathertree/ipc';

export type UnitySide = UnityConflictSideDto;

/** 列見出し。未マージなら 自分側 / 相手側。 */
export function unityColumnLabels(conflict: UnityConflictDto | null): readonly [string, string] {
  return conflict === null ? ['変更前', '変更後'] : ['自分側（ours）', '相手側（theirs）'];
}

/** ノード id で引けるようにする（描画のたびに配列をなめない）。 */
export function conflictEntryIndex(conflict: UnityConflictDto | null): ReadonlyMap<string, UnityConflictEntryDto> {
  const index = new Map<string, UnityConflictEntryDto>();
  for (const entry of conflict?.entries ?? []) index.set(entry.id, entry);
  return index;
}

/** そのノードの採用側。まだ決まっていない・両側が同じなら null。 */
export function adoptedSide(
  conflict: UnityConflictDto | null,
  index: ReadonlyMap<string, UnityConflictEntryDto>,
  choices: ReadonlyMap<string, UnitySide>,
  nodeId: string,
): UnitySide | null {
  if (conflict === null) return null;
  const entry = index.get(nodeId);
  if (entry === undefined) return null;
  if (conflict.units.includes(entry.unit)) return choices.get(entry.unit) ?? null;
  return entry.auto;
}

/**
 * そのノードが「両側が変えた」衝突そのものか（自動で決まった片側だけの変更ではない）。
 * 衝突は強調色（コンフリ色）で出す。ヒエラルキーの名前と、差分ペインの行の両方で使う。
 */
export function isConflictNode(
  conflict: UnityConflictDto | null,
  index: ReadonlyMap<string, UnityConflictEntryDto>,
  nodeId: string,
): boolean {
  if (conflict === null) return false;
  const entry = index.get(nodeId);
  return entry !== undefined && entry.auto === null;
}

/** まだ採用していない単位の数。0 になるまで「適用」は押せない。 */
export function unchosenCount(conflict: UnityConflictDto | null, choices: ReadonlyMap<string, UnitySide>): number {
  if (conflict === null) return 0;
  return conflict.units.filter((unit) => !choices.has(unit)).length;
}

/** 「適用」を押せない理由。押せるなら null（ボタンの title に出す）。 */
export function writeBlocker(conflict: UnityConflictDto | null, choices: ReadonlyMap<string, UnitySide>): string | null {
  if (conflict === null) return '未マージのファイルではありません。';
  if (!conflict.resolvable) {
    if (conflict.ours === 'absent') return '自分側ではこのファイルは削除されているため、GameObject 単位では解消できません。';
    if (conflict.theirs === 'absent') return '相手側ではこのファイルは削除されているため、GameObject 単位では解消できません。';
    return 'このファイルは GameObject 単位では解消できません。';
  }
  const rest = unchosenCount(conflict, choices);
  return rest > 0 ? `自分側・相手側のどちらもまだ採用していない GameObject が ${String(rest)} 件あります。` : null;
}
