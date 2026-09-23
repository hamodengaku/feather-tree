import { describe, expect, it } from 'vitest';
import { buildSideTree, parseUnityFile, type SideTree } from '../src/index.js';

/*
 * ヒエラルキー構築の単体テスト（Phase 12 M2）。
 *
 * **最初のテストが「親子が Transform 経由で正しく組めること」**なのは意図的で、
 * ここが実装で最も間違えやすい（F-2）。GameObject 同士は直接つながっておらず、
 * 親子も兄弟の順序も Transform が持っている。
 */

const LF = String.fromCharCode(10);

function text(...lines: readonly string[]): string {
  return lines.join(LF);
}

const HEADER = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:'] as const;

/**
 * Player
 *   ├ Transform / Animator（コンポーネント）
 *   ├ Weapon（子。Transform / MeshRenderer を持つ）
 *   └ Effects（子）
 *
 * わざと「ドキュメントの出現順」と「m_Children の順」を食い違わせてある
 * （Effects が先に書かれているが、m_Children では Weapon が先）。
 */
const PREFAB = text(
  ...HEADER,
  '--- !u!1 &100',
  'GameObject:',
  '  m_Component:',
  '  - component: {fileID: 101}',
  '  - component: {fileID: 102}',
  '  m_Name: Player',
  '  m_IsActive: 1',
  '--- !u!1 &300',
  'GameObject:',
  '  m_Component:',
  '  - component: {fileID: 301}',
  '  m_Name: Effects',
  '  m_IsActive: 1',
  '--- !u!4 &301',
  'Transform:',
  '  m_GameObject: {fileID: 300}',
  '  m_Children: []',
  '  m_Father: {fileID: 101}',
  '--- !u!4 &101',
  'Transform:',
  '  m_GameObject: {fileID: 100}',
  '  m_LocalPosition: {x: 0, y: 0, z: 0}',
  '  m_Children:',
  '  - {fileID: 201}',
  '  - {fileID: 301}',
  '  m_Father: {fileID: 0}',
  '--- !u!95 &102',
  'Animator:',
  '  m_GameObject: {fileID: 100}',
  '  m_Enabled: 1',
  '--- !u!1 &200',
  'GameObject:',
  '  m_Component:',
  '  - component: {fileID: 201}',
  '  - component: {fileID: 202}',
  '  m_Name: Weapon',
  '  m_IsActive: 1',
  '--- !u!4 &201',
  'Transform:',
  '  m_GameObject: {fileID: 200}',
  '  m_Children: []',
  '  m_Father: {fileID: 101}',
  '--- !u!23 &202',
  'MeshRenderer:',
  '  m_GameObject: {fileID: 200}',
  '  m_Enabled: 1',
  '',
);

function treeOf(src: string, resolve?: (guid: string) => string | null): SideTree {
  return buildSideTree(parseUnityFile(src), resolve);
}

/** 子の並びを「名前」で取り出す（読みやすさのため）。 */
function childNames(tree: SideTree, id: string): readonly string[] {
  return (tree.nodes.get(id)?.children ?? []).map((c) => tree.nodes.get(c)?.name ?? '?');
}

describe('親子は Transform 経由で組む（F-2 の関門）', () => {
  const tree = treeOf(PREFAB);

  it('ルートは m_Father が 0 の GameObject だけ', () => {
    expect(tree.roots.map((id) => tree.nodes.get(id)?.name)).toEqual(['Player']);
  });

  it('子 GameObject の親は、自分の Transform の m_Father が指す Transform の GameObject', () => {
    expect(tree.nodes.get('200')?.parent).toBe('100');
    expect(tree.nodes.get('300')?.parent).toBe('100');
  });

  it('コンポーネントは自分が指す GameObject の子になる', () => {
    expect(tree.nodes.get('101')?.parent).toBe('100');
    expect(tree.nodes.get('102')?.parent).toBe('100');
    expect(tree.nodes.get('202')?.parent).toBe('200');
  });

  it('Transform 自身もヒエラルキーに 1 ノードとして並ぶ（要件 7）', () => {
    expect(tree.nodes.get('101')?.kind).toBe('component');
    expect(tree.nodes.get('101')?.name).toBe('Transform');
  });
});

describe('兄弟の順序', () => {
  const tree = treeOf(PREFAB);

  it('コンポーネントが先、子 GameObject が後', () => {
    expect(childNames(tree, '100')).toEqual(['Transform', 'Animator', 'Weapon', 'Effects']);
  });

  it('コンポーネントは m_Component の順に並ぶ', () => {
    expect(childNames(tree, '200')).toEqual(['Transform', 'MeshRenderer']);
  });

  it('子 GameObject は m_Children の順に並ぶ（ドキュメントの出現順ではない）', () => {
    // Effects のほうが先に書かれているが、m_Children では Weapon が先
    const kids = childNames(tree, '100').slice(2);
    expect(kids).toEqual(['Weapon', 'Effects']);
  });
});

describe('RectTransform も親子を持つ', () => {
  const tree = treeOf(
    text(
      ...HEADER,
      '--- !u!1 &10',
      'GameObject:',
      '  m_Component:',
      '  - component: {fileID: 11}',
      '  m_Name: Canvas',
      '--- !u!224 &11',
      'RectTransform:',
      '  m_GameObject: {fileID: 10}',
      '  m_Children:',
      '  - {fileID: 21}',
      '  m_Father: {fileID: 0}',
      '--- !u!1 &20',
      'GameObject:',
      '  m_Component:',
      '  - component: {fileID: 21}',
      '  m_Name: Button',
      '--- !u!224 &21',
      'RectTransform:',
      '  m_GameObject: {fileID: 20}',
      '  m_Children: []',
      '  m_Father: {fileID: 11}',
      '',
    ),
  );

  it('RectTransform でも親子が組める', () => {
    expect(tree.roots.map((id) => tree.nodes.get(id)?.name)).toEqual(['Canvas']);
    expect(tree.nodes.get('20')?.parent).toBe('10');
    expect(childNames(tree, '10')).toEqual(['RectTransform', 'Button']);
  });
});

describe('表示名', () => {
  const src = text(
    ...HEADER,
    '--- !u!1 &10',
    'GameObject:',
    '  m_Component:',
    '  - component: {fileID: 11}',
    '  - component: {fileID: 12}',
    '  m_Name: Player',
    '--- !u!4 &11',
    'Transform:',
    '  m_GameObject: {fileID: 10}',
    '  m_Children: []',
    '  m_Father: {fileID: 0}',
    '--- !u!114 &12',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 10}',
    '  m_Script: {fileID: 11500000, guid: a1b2c3d4e5f60718, type: 3}',
    '',
  );

  it('GameObject は m_Name', () => {
    expect(treeOf(src).nodes.get('10')?.name).toBe('Player');
  });

  it('MonoBehaviour は既定で guid の先頭 8 桁を添える（要件 11）', () => {
    expect(treeOf(src).nodes.get('12')?.name).toBe('MonoBehaviour (a1b2c3d4)');
  });

  it('索引があればスクリプト名に差し替わる（M7 で埋める）', () => {
    const resolve = (guid: string): string | null =>
      guid === 'a1b2c3d4e5f60718' ? 'WeaponController' : null;
    expect(treeOf(src, resolve).nodes.get('12')?.name).toBe('WeaponController');
  });

  it('普通のコンポーネントはクラス名そのもの', () => {
    expect(treeOf(src).nodes.get('11')?.name).toBe('Transform');
  });
});

describe('PrefabInstance（Variant / ネスト Prefab）', () => {
  const tree = treeOf(
    text(
      ...HEADER,
      '--- !u!1 &10',
      'GameObject:',
      '  m_Component:',
      '  - component: {fileID: 11}',
      '  m_Name: Player',
      '--- !u!4 &11',
      'Transform:',
      '  m_GameObject: {fileID: 10}',
      '  m_Children: []',
      '  m_Father: {fileID: 0}',
      '--- !u!1001 &50',
      'PrefabInstance:',
      '  m_ObjectHideFlags: 0',
      '  serializedVersion: 2',
      '  m_Modification:',
      '    serializedVersion: 3',
      '    m_TransformParent: {fileID: 11}',
      '    m_Modifications:',
      '    - target: {fileID: 111, guid: ccc, type: 3}',
      '      propertyPath: m_Name',
      '      value: Sword',
      '      objectReference: {fileID: 0}',
      '    m_RemovedComponents: []',
      '  m_SourcePrefab: {fileID: 100100000, guid: bbbbbbbbcccccccc, type: 3}',
      '',
    ),
  );

  it('1 ノードとしてヒエラルキーに並ぶ（要件 9）', () => {
    expect(tree.nodes.get('50')?.kind).toBe('prefabInstance');
  });

  it('親は m_Modification.m_TransformParent が指す Transform の GameObject', () => {
    expect(tree.nodes.get('50')?.parent).toBe('10');
    expect(childNames(tree, '10')).toEqual(['Transform', 'PrefabInstance (bbbbbbbb)']);
  });

  it('索引があれば元 Prefab 名に差し替わる', () => {
    const resolve = (guid: string): string | null =>
      guid === 'bbbbbbbbcccccccc' ? 'Actor.prefab' : null;
    const resolved = buildSideTree(
      parseUnityFile(
        text(
          ...HEADER,
          '--- !u!1001 &50',
          'PrefabInstance:',
          '  m_Modification:',
          '    m_TransformParent: {fileID: 0}',
          '  m_SourcePrefab: {fileID: 100100000, guid: bbbbbbbbcccccccc, type: 3}',
          '',
        ),
      ),
      resolve,
    );
    expect(resolved.nodes.get('50')?.name).toBe('Actor.prefab');
  });
});

describe('壊れた・変わった入力', () => {
  it('Transform が無い GameObject もルートとして出す（消さない）', () => {
    const tree = treeOf(
      text(...HEADER, '--- !u!1 &10', 'GameObject:', '  m_Name: Orphan', ''),
    );
    expect(tree.roots).toEqual(['10']);
    expect(tree.nodes.get('10')?.name).toBe('Orphan');
  });

  it('m_Father が存在しない fileID を指していてもルートに倒す', () => {
    const tree = treeOf(
      text(
        ...HEADER,
        '--- !u!1 &10',
        'GameObject:',
        '  m_Component:',
        '  - component: {fileID: 11}',
        '  m_Name: Lost',
        '--- !u!4 &11',
        'Transform:',
        '  m_GameObject: {fileID: 10}',
        '  m_Children: []',
        '  m_Father: {fileID: 999999}',
        '',
      ),
    );
    expect(tree.roots).toEqual(['10']);
  });

  it('所有者がいないコンポーネントもルートに出す（黙って捨てない）', () => {
    const tree = treeOf(
      text(...HEADER, '--- !u!23 &99', 'MeshRenderer:', '  m_GameObject: {fileID: 0}', ''),
    );
    expect(tree.roots).toEqual(['99']);
    expect(tree.nodes.get('99')?.kind).toBe('component');
  });

  it('空のファイルでも落ちない', () => {
    const tree = treeOf('');
    expect(tree.roots).toHaveLength(0);
    expect(tree.nodes.size).toBe(0);
  });
});
