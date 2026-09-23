/*
 * `PrefabInstance`(1001) の `m_Modification.m_Modifications` を表の行にする
 * （決定 32 / 要件 9）。
 *
 * Variant やネスト Prefab では、変更のほとんどがここに集まる:
 *
 * ```
 * m_Modifications:
 * - target: {fileID: 111, guid: aaa, type: 3}
 *   propertyPath: m_LocalScale.x
 *   value: 1.2
 *   objectReference: {fileID: 0}
 * ```
 *
 * これを `m_Modifications[3].value` のような添字つきで出すと読めないので、
 * **1 要素を 1 行にして、変数名を `propertyPath` にする**。
 *
 * 行番号は**要素の 4 行すべて**を指す。`value` の行だけをステージすると
 * `- target:` の行が index に入らず、**壊れた YAML** ができてしまうため。
 */

import type { UnityFile, UnitySequence, UnityValue } from '../model/types.js';
import { expandFlow } from '../parse/flow.js';
import { displayValue, readScalar } from '../parse/read.js';
import type { FlatProperty } from './flat.js';
import { linesOf } from './flat.js';

/** `flattenDocument` の中でこの道筋に来たら、ここが引き取る。 */
export const MODIFICATIONS_PATH = 'm_Modification.m_Modifications';

export function modificationRows(file: UnityFile, list: UnitySequence): readonly FlatProperty[] {
  const out: FlatProperty[] = [];

  // 同じ propertyPath が別の target に対して並ぶことがある（Variant では普通）。
  // そのままだと表の中で見分けが付かないので、重なるものにだけ fileID を添える
  const counts = new Map<string, number>();
  for (const item of list.items) {
    const path = propertyPathOf(file, item);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }

  list.items.forEach((item, index) => {
    const path = propertyPathOf(file, item);
    const target = fieldOf(file, item, 'target');
    const targetId = target === null ? '' : scanFileId(file, target);
    const ambiguous = (counts.get(path) ?? 0) > 1;

    let key = path === '' ? 'm_Modifications[' + String(index) + ']' : path;
    if (ambiguous && targetId !== '') key += ' (fileID ' + targetId + ')';

    out.push({ key, value: valueOf(file, item), lines: linesOf(item) });
  });

  return out;
}

function propertyPathOf(file: UnityFile, item: UnityValue): string {
  const path = fieldOf(file, item, 'propertyPath');
  if (path === null || path.kind !== 'scalar') return '';
  return readScalar(file, path);
}

/**
 * 表に出す値。
 *
 * `value` が空で `objectReference` が実体を指しているときは、そちらを出す。
 * Unity は「参照の差し替え」をこの形で書くので、`value` だけ見ていると
 * 参照の変更がすべて「空 → 空」に見えてしまう。
 */
function valueOf(file: UnityFile, item: UnityValue): string {
  const value = fieldOf(file, item, 'value');
  const text = value === null ? '' : displayValue(file, value);
  if (text !== '') return text;

  const reference = fieldOf(file, item, 'objectReference');
  if (reference === null) return text;
  const id = scanFileId(file, reference);
  if (id === '' || id === '0') return text;
  return displayValue(file, reference);
}

function fieldOf(file: UnityFile, item: UnityValue, key: string): UnityValue | null {
  const target = item.kind === 'scalar' ? expandFlow(file.text, item) : item;
  if (target.kind !== 'mapping') return null;
  for (const entry of target.entries) {
    if (entry.key === key) return entry.value;
  }
  return null;
}

function scanFileId(file: UnityFile, value: UnityValue): string {
  const opened = value.kind === 'scalar' ? expandFlow(file.text, value) : value;
  if (opened.kind !== 'mapping') return '';
  for (const entry of opened.entries) {
    if (entry.key === 'fileID' && entry.value.kind === 'scalar') {
      return readScalar(file, entry.value);
    }
  }
  return '';
}
