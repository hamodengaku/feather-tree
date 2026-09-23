/*
 * 選んだ 1 ノードを「変数 / 変更前 / 変更後」の表にする（決定 32 / 要件 8）。
 *
 * **全変数を出して、変更行だけ強調する。** 未変更行は renderer 側で 2 列を結合して
 * 値を 1 回だけ弱色で出す（そのため `same` の行は before と after が同じ値になる）。
 *
 * 各行は**旧側・新側の行番号**を持つ。これが `map/lineMap.ts` で hunk / 行の座標に
 * 変わり、「1 パラメータだけステージ」になる（A-3）。ここが空の行はステージできない。
 *
 * 呼ばれるのは**利用者が選んだ 1 ノードのときだけ**。ここで初めて
 * `documentBody`（本体の組み立て）と `expandFlow`（フローの分解）が走る（F-1）。
 */

import type { UnityDocument, UnityFile, UnityValue } from '../model/types.js';
import { documentBody } from '../parse/document.js';
import { expandFlow } from '../parse/flow.js';
import { displayValue, rawText } from '../parse/read.js';
import type { FlatProperty } from './flat.js';
import { linesOf } from './flat.js';
import { modificationRows, MODIFICATIONS_PATH } from './prefabInstance.js';

export type RowState = 'same' | 'changed' | 'added' | 'removed';

export interface PropertyRow {
  /** 表の「変数」列。`m_LocalPosition.x` のような道筋。 */
  readonly key: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly state: RowState;
  /** 旧側でこの行が占める行番号（1 始まり）。無ければ空。 */
  readonly oldLines: readonly number[];
  /** 新側でこの行が占める行番号。 */
  readonly newLines: readonly number[];
}

/**
 * 1 ドキュメントを平らな「変数と値」の並びにする。
 *
 * フローマッピングは `m_LocalPosition.x` のように展開する（要件 8 の見せ方）。
 * **ただし同じ行に乗っている**ので、1 つをステージすると同じ行の兄弟も一緒に入る。
 * それは git の粒度が行である以上避けられないので、呼び出し側が行番号の重なりで気づける形にしてある。
 */
export function flattenDocument(file: UnityFile, doc: UnityDocument): readonly FlatProperty[] {
  const body = documentBody(file, doc);
  // 本体が空のドキュメント（stripped などで中身が無いもの）は行を出さない。
  // 空のマッピングを素通しすると、キーが空の幽霊行が 1 本出てしまう
  if (body.entries.length === 0) return [];
  const out: FlatProperty[] = [];
  flattenValue(file, body, '', out, doc.classId);
  return out;
}

function flattenValue(
  file: UnityFile,
  value: UnityValue,
  path: string,
  out: FlatProperty[],
  classId: number,
): void {
  if (value.kind === 'scalar') {
    if (value.style === 'flow') {
      const opened = expandFlow(file.text, value);
      if (opened !== value) {
        flattenValue(file, opened, path, out, classId);
        return;
      }
    }
    push(out, path, displayValue(file, value), value);
    return;
  }

  if (value.kind === 'mapping') {
    if (value.entries.length === 0) {
      push(out, path, rawText(file, value).trim(), value);
      return;
    }
    // 重複キーは `key #2` のように番号を添えて、表の中で一意にする
    const seen = new Map<string, number>();
    for (const entry of value.entries) {
      const count = seen.get(entry.key) ?? 0;
      seen.set(entry.key, count + 1);
      const label = count === 0 ? entry.key : entry.key + ' #' + String(count + 1);
      flattenValue(file, entry.value, join(path, label), out, classId);
    }
    return;
  }

  if (value.items.length === 0) {
    push(out, path, rawText(file, value).trim(), value);
    return;
  }

  // PrefabInstance の m_Modifications だけは propertyPath を変数名にする（要件 9）
  if (classId === CLASS_PREFAB_INSTANCE && path === MODIFICATIONS_PATH) {
    out.push(...modificationRows(file, value));
    return;
  }

  value.items.forEach((item, index) => {
    flattenValue(file, item, path + '[' + String(index) + ']', out, classId);
  });
}

const CLASS_PREFAB_INSTANCE = 1001;

function join(path: string, key: string): string {
  return path === '' ? key : path + '.' + key;
}

function push(out: FlatProperty[], key: string, value: string, at: UnityValue): void {
  out.push({ key, value, lines: linesOf(at) });
}

/* ------------------------------------------------------------------ 新旧の突き合わせ */

/**
 * 旧側・新側の 1 ドキュメントから表を組む。
 *
 * ヒエラルキーと同じ規則で、**新側を軸に、旧側にしか無い行を旧側での位置に差し込む**。
 * 片側が null（追加・削除されたノード）なら、全行が `added` / `removed` になる。
 */
export function buildRows(
  oldFile: UnityFile | null,
  oldDoc: UnityDocument | null,
  newFile: UnityFile | null,
  newDoc: UnityDocument | null,
): readonly PropertyRow[] {
  const oldProps =
    oldFile !== null && oldDoc !== null ? flattenDocument(oldFile, oldDoc) : [];
  const newProps =
    newFile !== null && newDoc !== null ? flattenDocument(newFile, newDoc) : [];

  const oldByKey = new Map<string, FlatProperty>();
  for (const prop of oldProps) if (!oldByKey.has(prop.key)) oldByKey.set(prop.key, prop);
  const newByKey = new Map<string, FlatProperty>();
  for (const prop of newProps) if (!newByKey.has(prop.key)) newByKey.set(prop.key, prop);

  // 新側の並びを軸にする
  const keys = newProps.map((p) => p.key);

  // 旧側にしか無いキーを、旧側での位置に差し込む
  for (let i = 0; i < oldProps.length; i += 1) {
    const prop = oldProps[i];
    if (prop === undefined || newByKey.has(prop.key)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = oldProps[j];
      if (prev === undefined) continue;
      const pos = keys.indexOf(prev.key);
      if (pos >= 0) {
        at = pos + 1;
        break;
      }
    }
    keys.splice(at, 0, prop.key);
  }

  const rows: PropertyRow[] = [];
  for (const key of keys) {
    const before = oldByKey.get(key);
    const after = newByKey.get(key);

    let state: RowState;
    if (before === undefined) state = 'added';
    else if (after === undefined) state = 'removed';
    else state = before.value === after.value ? 'same' : 'changed';

    rows.push({
      key,
      before: before?.value ?? null,
      after: after?.value ?? null,
      state,
      oldLines: before?.lines ?? [],
      newLines: after?.lines ?? [],
    });
  }
  return rows;
}
