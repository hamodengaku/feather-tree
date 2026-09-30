/*
 * 新旧のシートの対応（決定 33）。
 *
 *   1. **名前が同じもの**を先に対にする
 *   2. 残りを **sheetId が同じもの**で対にする（名前の変更を「削除 + 追加」ではなく「名前変更」として出す）
 *   3. どちらにも当たらないものは追加 / 削除
 *
 * 名前を先にするのは、openpyxl などのツールが保存のたびに sheetId を振り直すことがあるため
 * （sheetId を先にすると、名前も中身も同じシートを別のシートと取り違える）。
 *
 * 並びは**新側の順**。削除されたシートは、旧側で直前にあったシートの後ろに差し込む。
 */

import type { SheetInfo } from '../model/types.js';

export interface SheetPair {
  readonly old: SheetInfo | null;
  readonly new: SheetInfo | null;
}

export function matchSheets(oldSheets: readonly SheetInfo[], newSheets: readonly SheetInfo[]): SheetPair[] {
  const oldToNew = new Int32Array(oldSheets.length).fill(-1);
  const newTaken = new Uint8Array(newSheets.length);

  const byName = new Map<string, number>();
  newSheets.forEach((s, j) => {
    if (!byName.has(s.name)) byName.set(s.name, j);
  });
  oldSheets.forEach((s, i) => {
    const j = byName.get(s.name);
    if (j !== undefined && newTaken[j] === 0) {
      oldToNew[i] = j;
      newTaken[j] = 1;
    }
  });

  const byId = new Map<number, number>();
  newSheets.forEach((s, j) => {
    if (newTaken[j] === 0 && s.sheetId >= 0 && !byId.has(s.sheetId)) byId.set(s.sheetId, j);
  });
  oldSheets.forEach((s, i) => {
    if (oldToNew[i] !== -1 || s.sheetId < 0) return;
    const j = byId.get(s.sheetId);
    if (j !== undefined && newTaken[j] === 0) {
      oldToNew[i] = j;
      newTaken[j] = 1;
    }
  });

  const newToOld = new Int32Array(newSheets.length).fill(-1);
  oldToNew.forEach((j, i) => {
    if (j >= 0) newToOld[j] = i;
  });

  // 新側の順に並べ、削除されたシートは旧側の直前のシートの後ろへ
  const removedAfter = new Map<number, number[]>(); // 新側の添字（-1 は先頭）→ 旧側の添字
  let anchor = -1;
  oldSheets.forEach((_, i) => {
    const j = oldToNew[i] ?? -1;
    if (j >= 0) {
      anchor = j;
      return;
    }
    const list = removedAfter.get(anchor) ?? [];
    list.push(i);
    removedAfter.set(anchor, list);
  });

  const out: SheetPair[] = [];
  const pushRemoved = (key: number): void => {
    for (const i of removedAfter.get(key) ?? []) out.push({ old: oldSheets[i] ?? null, new: null });
  };
  pushRemoved(-1);
  newSheets.forEach((s, j) => {
    const i = newToOld[j] ?? -1;
    out.push({ old: i >= 0 ? (oldSheets[i] ?? null) : null, new: s });
    pushRemoved(j);
  });
  return out;
}
