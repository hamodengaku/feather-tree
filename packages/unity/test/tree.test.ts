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

/*
 * Variant（2026-09-30）。自前の GameObject を持たず、ルートは PrefabInstance。
 * 元 Prefab のオブジェクトは stripped な代理として並ぶ:
 *   - stripped GameObject（名前は m_Modifications の m_Name で上書きされている）
 *   - stripped Transform
 *   - stripped MonoBehaviour（m_Script を持たない）
 *   - Variant 側で stripped GameObject に**足した** MonoBehaviour（本体あり）
 */
describe('stripped（継承した代理）の配置', () => {
  const VARIANT = text(
    ...HEADER,
    '--- !u!1 &900 stripped',
    'GameObject:',
    '  m_CorrespondingSourceObject: {fileID: 111, guid: bbbbbbbbcccccccc, type: 3}',
    '  m_PrefabInstance: {fileID: 50}',
    '  m_PrefabAsset: {fileID: 0}',
    '--- !u!4 &901 stripped',
    'Transform:',
    '  m_CorrespondingSourceObject: {fileID: 112, guid: bbbbbbbbcccccccc, type: 3}',
    '  m_PrefabInstance: {fileID: 50}',
    '  m_PrefabAsset: {fileID: 0}',
    '--- !u!114 &902 stripped',
    'MonoBehaviour:',
    '  m_CorrespondingSourceObject: {fileID: 113, guid: bbbbbbbbcccccccc, type: 3}',
    '  m_PrefabInstance: {fileID: 50}',
    '  m_PrefabAsset: {fileID: 0}',
    '--- !u!114 &903',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 900}',
    '  m_Script: {fileID: 11500000, guid: ddddddddeeeeeeee, type: 3}',
    '--- !u!1001 &50',
    'PrefabInstance:',
    '  m_Modification:',
    '    m_TransformParent: {fileID: 0}',
    '    m_Modifications:',
    '    - target: {fileID: 111, guid: bbbbbbbbcccccccc, type: 3}',
    '      propertyPath: m_Name',
    '      value: EnemyVariant',
    '      objectReference: {fileID: 0}',
    '  m_SourcePrefab: {fileID: 100100000, guid: bbbbbbbbcccccccc, type: 3}',
    '',
  );
  const tree = treeOf(VARIANT);

  it('stripped はすべて持ち込んだ PrefabInstance の下に入り、ルートに散らばらない', () => {
    expect(tree.roots).toEqual(['50']);
    expect(tree.nodes.get('900')?.parent).toBe('50');
    expect(tree.nodes.get('901')?.parent).toBe('50');
    expect(tree.nodes.get('902')?.parent).toBe('50');
  });

  it('stripped には継承の印が付き、名前は m_Modifications の上書きから取る', () => {
    expect(tree.nodes.get('900')).toMatchObject({ name: 'EnemyVariant', inherited: true });
    expect(tree.nodes.get('902')).toMatchObject({ name: 'MonoBehaviour', inherited: true });
    expect(tree.nodes.get('903')?.inherited).toBe(false);
  });

  it('継承した GameObject に足したコンポーネントはその GameObject の下（PrefabInstance ＞ GO ＞ 足した物）', () => {
    expect(tree.nodes.get('903')?.parent).toBe('900');
  });

  it('m_Script を持つ MonoBehaviour は解決の有無によらず検索できる。純粋な MonoBehaviour（継承）はできない', () => {
    expect(tree.nodes.get('903')).toMatchObject({ name: 'MonoBehaviour (dddddddd)', scriptSearchable: true });
    // stripped は m_Script を持たないので「検索」しても変わらない。ボタンも出さない
    expect(tree.nodes.get('902')?.scriptSearchable).toBe(false);

    const resolved = buildSideTree(parseUnityFile(VARIANT), (guid) =>
      guid === 'ddddddddeeeeeeee' ? 'EnemyAI' : null,
    );
    // 名前が付いても、ボタンは残す（リネームの取り直し用。2026-10-03 利用者の指示）
    expect(resolved.nodes.get('903')).toMatchObject({ name: 'EnemyAI', scriptSearchable: true });
  });

  it('uGUI・TextMeshPro は既知表で検索せずに名前が付き、走査の結果があればそちらを優先する', () => {
    const withText = (guid: string): string =>
      text(
        ...HEADER,
        '--- !u!1 &10',
        'GameObject:',
        '  m_Component:',
        '  - component: {fileID: 11}',
        '  m_Name: Label',
        '--- !u!114 &11',
        'MonoBehaviour:',
        '  m_GameObject: {fileID: 10}',
        '  m_Script: {fileID: 11500000, guid: ' + guid + ', type: 3}',
        '',
      );
    expect(treeOf(withText('f4688fdb7df04437aeb418b961361dc5')).nodes.get('11')).toMatchObject({
      name: 'TextMeshProUGUI',
      scriptSearchable: true,
    });
    expect(treeOf(withText('5f7201a12d95ffc409449d95f23cf332')).nodes.get('11')?.name).toBe('Text');
    // PackageCache を走査して得た名前が既知表に勝つ
    const scanned = treeOf(withText('5f7201a12d95ffc409449d95f23cf332'), () => 'LegacyText');
    expect(scanned.nodes.get('11')?.name).toBe('LegacyText');
  });

  it('名前の上書きが無い stripped GameObject は GameObject と出す', () => {
    const plain = treeOf(VARIANT.replace('propertyPath: m_Name', 'propertyPath: m_IsActive'));
    expect(plain.nodes.get('900')?.name).toBe('GameObject');
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
