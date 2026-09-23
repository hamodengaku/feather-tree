import { describe, expect, it } from 'vitest';
import { buildRows, parseUnityFile, type PropertyRow, type UnityFile } from '../src/index.js';

/*
 * プロパティ表（Phase 12 M2 / 要件 8・9）。
 *
 * 行番号（oldLines / newLines）は **M3 でステージの座標になる**ので、
 * 値と同じくらい厚く見る。特に `m_Modifications` の 1 要素が
 * 4 行すべてを指すことは、壊れた YAML を index に入れないための要。
 */

const LF = String.fromCharCode(10);

function text(...lines: readonly string[]): string {
  return lines.join(LF);
}

const HEADER = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:'] as const;

function rowsOf(oldSrc: string | null, newSrc: string | null): readonly PropertyRow[] {
  const oldFile: UnityFile | null = oldSrc === null ? null : parseUnityFile(oldSrc);
  const newFile: UnityFile | null = newSrc === null ? null : parseUnityFile(newSrc);
  return buildRows(
    oldFile,
    oldFile?.documents[0] ?? null,
    newFile,
    newFile?.documents[0] ?? null,
  );
}

function row(rows: readonly PropertyRow[], key: string): PropertyRow {
  const found = rows.find((r) => r.key === key);
  expect(found, 'row not found: ' + key).toBeDefined();
  if (found === undefined) throw new Error('missing');
  return found;
}

const TRANSFORM = (x: string, active: string): string =>
  text(
    ...HEADER,
    '--- !u!4 &100',
    'Transform:',
    '  m_GameObject: {fileID: 200}',
    '  m_LocalPosition: {x: ' + x + ', y: 0, z: 0}',
    '  m_Enabled: ' + active,
    '',
  );

describe('全変数を出して、変更行だけ印を付ける（要件 8）', () => {
  const rows = rowsOf(TRANSFORM('0', '1'), TRANSFORM('1.5', '0'));

  it('変わっていない変数も行として出る', () => {
    expect(row(rows, 'm_LocalPosition.y').state).toBe('same');
    expect(row(rows, 'm_GameObject.fileID').state).toBe('same');
  });

  it('未変更行は変更前と変更後が同じ値（renderer が 2 列を結合できる）', () => {
    const same = row(rows, 'm_LocalPosition.y');
    expect(same.before).toBe('0');
    expect(same.after).toBe('0');
  });

  it('変わった変数は changed で、前後の値が違う', () => {
    expect(row(rows, 'm_LocalPosition.x')).toMatchObject({
      state: 'changed',
      before: '0',
      after: '1.5',
    });
    expect(row(rows, 'm_Enabled')).toMatchObject({ state: 'changed', before: '1', after: '0' });
  });

  it('フローマッピングは `.x` のように展開する（要件 8 の見せ方）', () => {
    expect(rows.map((r) => r.key)).toContain('m_LocalPosition.x');
    expect(rows.map((r) => r.key)).toContain('m_LocalPosition.z');
  });
});

describe('行番号', () => {
  const rows = rowsOf(TRANSFORM('0', '1'), TRANSFORM('1.5', '0'));

  it('各行が旧側・新側の行番号を持つ', () => {
    expect(row(rows, 'm_Enabled').oldLines).toEqual([7]);
    expect(row(rows, 'm_Enabled').newLines).toEqual([7]);
  });

  it('同じフロー行に乗る変数は同じ行番号になる（1 行より細かくはステージできない）', () => {
    const x = row(rows, 'm_LocalPosition.x');
    const y = row(rows, 'm_LocalPosition.y');
    expect(x.newLines).toEqual(y.newLines);
    expect(x.newLines).toEqual([6]);
  });

  it('ブロックスカラは複数行にまたがる', () => {
    const src = (body: string): string =>
      text(
        ...HEADER,
        '--- !u!114 &1',
        'MonoBehaviour:',
        '  m_Text: |',
        '    line one',
        '    ' + body,
        '',
      );
    const rows2 = rowsOf(src('line two'), src('line TWO'));
    expect(row(rows2, 'm_Text').state).toBe('changed');
    expect(row(rows2, 'm_Text').newLines).toEqual([5, 6, 7]);
  });
});

describe('追加・削除された変数', () => {
  const before = text(
    ...HEADER,
    '--- !u!114 &1',
    'MonoBehaviour:',
    '  m_A: 1',
    '  m_B: 2',
    '  m_C: 3',
    '',
  );
  const after = text(
    ...HEADER,
    '--- !u!114 &1',
    'MonoBehaviour:',
    '  m_A: 1',
    '  m_D: 4',
    '  m_C: 3',
    '',
  );

  it('新側にしか無い変数は added', () => {
    const r = row(rowsOf(before, after), 'm_D');
    expect(r.state).toBe('added');
    expect(r.before).toBeNull();
    expect(r.oldLines).toEqual([]);
  });

  it('旧側にしか無い変数は removed', () => {
    const r = row(rowsOf(before, after), 'm_B');
    expect(r.state).toBe('removed');
    expect(r.after).toBeNull();
    expect(r.newLines).toEqual([]);
  });

  it('旧側だけの行は旧側での位置に差し込む（ヒエラルキーと同じ規則）', () => {
    expect(rowsOf(before, after).map((r) => r.key)).toEqual(['m_A', 'm_B', 'm_D', 'm_C']);
  });

  it('ノードごと追加されたら全行が added', () => {
    const rows = rowsOf(null, after);
    expect(rows.every((r) => r.state === 'added')).toBe(true);
    expect(rows.every((r) => r.before === null)).toBe(true);
  });

  it('ノードごと削除されたら全行が removed', () => {
    const rows = rowsOf(before, null);
    expect(rows.every((r) => r.state === 'removed')).toBe(true);
  });
});

describe('重複キー', () => {
  it('2 つめ以降に番号を添えて表の中で一意にする', () => {
    const src = (second: string): string =>
      text(
        ...HEADER,
        '--- !u!114 &1',
        'MonoBehaviour:',
        '  m_Name: first',
        '  m_Name: ' + second,
        '',
      );
    const rows = rowsOf(src('second'), src('SECOND'));
    expect(rows.map((r) => r.key)).toEqual(['m_Name', 'm_Name #2']);
    expect(row(rows, 'm_Name').state).toBe('same');
    expect(row(rows, 'm_Name #2')).toMatchObject({ state: 'changed', after: 'SECOND' });
  });
});

describe('PrefabInstance の m_Modifications（要件 9）', () => {
  const src = (scale: string): string =>
    text(
      ...HEADER,
      '--- !u!1001 &50',
      'PrefabInstance:',
      '  m_Modification:',
      '    m_TransformParent: {fileID: 0}',
      '    m_Modifications:',
      '    - target: {fileID: 111, guid: aaa, type: 3}',
      '      propertyPath: m_Name',
      '      value: Player',
      '      objectReference: {fileID: 0}',
      '    - target: {fileID: 111, guid: aaa, type: 3}',
      '      propertyPath: m_LocalScale.x',
      '      value: ' + scale,
      '      objectReference: {fileID: 0}',
      '  m_SourcePrefab: {fileID: 100100000, guid: bbb, type: 3}',
      '',
    );

  const rows = rowsOf(src('1'), src('1.2'));

  it('変数名が propertyPath になる（添字ではなく）', () => {
    expect(rows.map((r) => r.key)).toContain('m_Name');
    expect(rows.map((r) => r.key)).toContain('m_LocalScale.x');
    expect(rows.map((r) => r.key).some((k) => k.includes('m_Modifications['))).toBe(false);
  });

  it('値は value を出す', () => {
    expect(row(rows, 'm_LocalScale.x')).toMatchObject({
      state: 'changed',
      before: '1',
      after: '1.2',
    });
  });

  it('1 要素は 4 行すべてを指す（value の行だけ入れると YAML が壊れるため）', () => {
    expect(row(rows, 'm_LocalScale.x').newLines).toEqual([12, 13, 14, 15]);
    expect(row(rows, 'm_Name').newLines).toEqual([8, 9, 10, 11]);
  });

  it('同じ propertyPath が別の target にあれば fileID を添えて見分ける', () => {
    const two = text(
      ...HEADER,
      '--- !u!1001 &50',
      'PrefabInstance:',
      '  m_Modification:',
      '    m_Modifications:',
      '    - target: {fileID: 111, guid: aaa, type: 3}',
      '      propertyPath: m_IsActive',
      '      value: 1',
      '      objectReference: {fileID: 0}',
      '    - target: {fileID: 222, guid: aaa, type: 3}',
      '      propertyPath: m_IsActive',
      '      value: 0',
      '      objectReference: {fileID: 0}',
      '',
    );
    const keys = rowsOf(two, two).map((r) => r.key);
    expect(keys).toContain('m_IsActive (fileID 111)');
    expect(keys).toContain('m_IsActive (fileID 222)');
  });

  it('value が空でも objectReference が実体を指していれば、そちらを出す', () => {
    const reference = (id: string): string =>
      text(
        ...HEADER,
        '--- !u!1001 &50',
        'PrefabInstance:',
        '  m_Modification:',
        '    m_Modifications:',
        '    - target: {fileID: 111, guid: aaa, type: 3}',
        '      propertyPath: m_Sprite',
        '      value:',
        '      objectReference: {fileID: ' + id + ', guid: ccc, type: 3}',
        '',
      );
    const r = row(rowsOf(reference('900'), reference('901')), 'm_Sprite');
    expect(r.state).toBe('changed');
    expect(r.before).toBe('{fileID: 900, guid: ccc, type: 3}');
    expect(r.after).toBe('{fileID: 901, guid: ccc, type: 3}');
  });
});

describe('壊れた・端の入力', () => {
  it('空のシーケンスは 1 行として出す', () => {
    const src = text(...HEADER, '--- !u!4 &1', 'Transform:', '  m_Children: []', '');
    expect(row(rowsOf(src, src), 'm_Children').after).toBe('[]');
  });

  it('本体が無いドキュメントでも落ちない', () => {
    const src = text(...HEADER, '--- !u!1 &1', '');
    expect(rowsOf(src, src)).toHaveLength(0);
  });

  it('両側 null なら行は無い', () => {
    expect(buildRows(null, null, null, null)).toHaveLength(0);
  });
});
