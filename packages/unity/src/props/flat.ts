/*
 * 表の 1 行を作るときに、`rows.ts` と `prefabInstance.ts` の両方が使う土台。
 *
 * ここを別ファイルにしてあるのは、双方向の import（循環）を作らないため
 * （`rows.ts` → `prefabInstance.ts` の 1 方向だけにする）。
 */

import type { UnityValue } from '../model/types.js';

/** 片側を平らにした 1 件。 */
export interface FlatProperty {
  readonly key: string;
  readonly value: string;
  /** その値が元ファイルで占める行番号（1 始まり）。ステージの座標の素になる。 */
  readonly lines: readonly number[];
}

/** その値が占める行。複数行に渡るもの（ブロックスカラ、`- target:` の 4 行）は全部入れる。 */
export function linesOf(value: UnityValue): readonly number[] {
  if (value.endLine <= value.startLine) return [value.startLine];
  const out: number[] = [];
  for (let i = value.startLine; i <= value.endLine; i += 1) out.push(i);
  return out;
}
