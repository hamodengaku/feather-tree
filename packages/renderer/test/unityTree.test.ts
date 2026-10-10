import { describe, expect, it } from 'vitest';
import type { UnityNodeDto } from '@feathertree/ipc';
import {
  expandToNode,
  initialUnityExpansion,
  visibleUnityRows,
} from '../src/lib/unityTree.js';

/*
 * ヒエラルキーの折り畳みと平坦化（Phase 12 M5 / 要件 7）。
 *
 * 初期状態は**全折りたたみで、変更のある節までの経路だけが開いている**。
 * 判定の材料（hasChangedDescendant）は main が計算して載せてくれるので、
 * ここは畳み方の規則だけを見る。
 */

function node(
  id: string,
  parent: number,
  depth: number,
  over: Partial<UnityNodeDto> = {},
): UnityNodeDto {
  return {
    id,
    parent,
    depth,
    kind: 'gameObject',
    classId: 1,
    name: id,
    inherited: false,
    scriptSearchable: false,
    mark: 'same',
    hasChangedDescendant: false,
    ...over,
  };
}

/**
 * Root
 *   ├ A        （この下に変更あり）
 *   │   └ A1   （変更）
 *   └ B
 *       └ B1
 */
const NODES: readonly UnityNodeDto[] = [
  node('Root', -1, 0, { hasChangedDescendant: true }),
  node('A', 0, 1, { hasChangedDescendant: true }),
  node('A1', 1, 2, { mark: 'changed' }),
  node('B', 0, 1),
  node('B1', 3, 2),
];

function names(nodes: readonly UnityNodeDto[], expanded: ReadonlySet<string>): readonly string[] {
  return visibleUnityRows(nodes, expanded).map((r) => r.node.name);
}

describe('初期の展開（変更のある節までの経路だけ）', () => {
  it('変更を抱えている祖先だけが開く', () => {
    expect([...initialUnityExpansion(NODES)].sort()).toEqual(['A', 'Root']);
  });

  it('その状態で、変更のある節まで見えて、関係ない枝は畳まれたまま', () => {
    expect(names(NODES, initialUnityExpansion(NODES))).toEqual(['Root', 'A', 'A1', 'B']);
  });

  it('どこにも変更が無ければ全部畳んだまま（ルートだけ見える）', () => {
    const flat = NODES.map((n) => ({ ...n, mark: 'same' as const, hasChangedDescendant: false }));
    expect(initialUnityExpansion(flat).size).toBe(0);
    expect(names(flat, new Set())).toEqual(['Root']);
  });
});

describe('畳み／展開', () => {
  it('畳まれた節の下は、子が開いていても出さない', () => {
    // A は開いているが Root が畳まれている
    expect(names(NODES, new Set(['A']))).toEqual(['Root']);
  });

  it('全部開けば全部見える', () => {
    expect(names(NODES, new Set(['Root', 'A', 'B']))).toEqual(['Root', 'A', 'A1', 'B', 'B1']);
  });

  it('子を持つ節にだけ twisty を出す', () => {
    const rows = visibleUnityRows(NODES, new Set(['Root', 'A', 'B']));
    expect(rows.map((r) => r.node.name + ':' + String(r.hasChildren))).toEqual([
      'Root:true',
      'A:true',
      'A1:false',
      'B:true',
      'B1:false',
    ]);
  });

  it('開いているかを行に載せる（twisty の向きに使う）', () => {
    const rows = visibleUnityRows(NODES, new Set(['Root']));
    expect(rows.find((r) => r.node.name === 'A')?.expanded).toBe(false);
  });

  it('元の配列での添字を保つ（選択の同一性に使う）', () => {
    const rows = visibleUnityRows(NODES, new Set(['Root', 'B']));
    expect(rows.map((r) => r.index)).toEqual([0, 1, 3, 4]);
  });
});

describe('その節まで開く', () => {
  it('祖先を全部開く（自分自身は開かない）', () => {
    const next = expandToNode(NODES, new Set(), 4);
    expect([...next].sort()).toEqual(['B', 'Root']);
  });

  it('ルート直下なら何も増えない', () => {
    expect(expandToNode(NODES, new Set(), 0).size).toBe(0);
  });

  it('既に開いているものは重ねない', () => {
    const next = expandToNode(NODES, new Set(['Root']), 2);
    expect([...next].sort()).toEqual(['A', 'Root']);
  });
});

describe('端の入力', () => {
  it('空でも落ちない', () => {
    expect(visibleUnityRows([], new Set())).toHaveLength(0);
    expect(initialUnityExpansion([]).size).toBe(0);
  });

  it('親の添字が壊れていても落ちない', () => {
    const broken = [node('X', 99, 0)];
    expect(() => visibleUnityRows(broken, new Set())).not.toThrow();
  });
});

/*
 * コンポーネントの別畳み（2026-10-02）。
 *
 * Player
 *   ├ Transform     （コンポーネント）
 *   ├ Mover         （コンポーネント・変更）
 *   └ Weapon        （子の GameObject）
 *       └ Renderer  （コンポーネント）
 */
describe('コンポーネントは名前をクリックするまで畳む', () => {
  const TREE: readonly UnityNodeDto[] = [
    node('Player', -1, 0, { hasChangedDescendant: true }),
    node('Transform', 0, 1, { kind: 'component' }),
    node('Mover', 0, 1, { kind: 'component', mark: 'changed' }),
    node('Weapon', 0, 1),
    node('Renderer', 3, 2, { kind: 'component' }),
  ];
  const shownNames = (expanded: ReadonlySet<string>, components: ReadonlySet<string>): readonly string[] =>
    visibleUnityRows(TREE, expanded, components).map((r) => r.node.name);

  it('開いていても、コンポーネントは出さず子の GameObject だけを出す', () => {
    expect(shownNames(new Set(['Player']), new Set())).toEqual(['Player', 'Weapon']);
  });

  it('名前をクリックした GameObject のコンポーネントだけが出る（並びは従来どおりコンポーネントが先）', () => {
    expect(shownNames(new Set(['Player']), new Set(['Player']))).toEqual([
      'Player',
      'Transform',
      'Mover',
      'Weapon',
    ]);
  });

  it('子を畳んでいてもコンポーネントは出せる（子の開閉と独立）', () => {
    expect(shownNames(new Set(), new Set(['Player']))).toEqual(['Player', 'Transform', 'Mover']);
  });

  it('twisty は子の GameObject がある行だけ。畳んだコンポーネントの変更は印で知らせる', () => {
    const rows = visibleUnityRows(TREE, new Set(['Player', 'Weapon']), new Set());
    const player = rows.find((r) => r.node.name === 'Player');
    const weapon = rows.find((r) => r.node.name === 'Weapon');
    expect(player).toMatchObject({ hasChildren: true, hasComponents: true, hiddenComponentChange: true });
    // Weapon の子はコンポーネントだけなので twisty は出さない
    expect(weapon).toMatchObject({ hasChildren: false, hasComponents: true, hiddenComponentChange: false });

    const opened = visibleUnityRows(TREE, new Set(['Player']), new Set(['Player']));
    expect(opened.find((r) => r.node.name === 'Player')?.hiddenComponentChange).toBe(false);
  });
});

/**
 * 畳まれた下の変更の印（hiddenChange）。開けば見える変更にだけ立てる（2026-10-10）。
 *
 * Root（移動）
 *   ├ RectTransform  （コンポーネント・変更）
 *   └ Panel
 *       ├ RectTransform（コンポーネント）
 *       └ Button
 *           └ RectTransform（コンポーネント・変更）
 */
describe('畳まれた下に変更があることの印', () => {
  const TREE: readonly UnityNodeDto[] = [
    node('Root', -1, 0, { mark: 'moved', hasChangedDescendant: true }),
    node('RootRT', 0, 1, { kind: 'component', mark: 'changed' }),
    node('Panel', 0, 1, { hasChangedDescendant: true }),
    node('PanelRT', 2, 2, { kind: 'component' }),
    node('Button', 2, 2, { hasChangedDescendant: true }),
    node('ButtonRT', 4, 3, { kind: 'component', mark: 'changed' }),
  ];
  const row = (expanded: ReadonlySet<string>, components: ReadonlySet<string>, name: string) =>
    visibleUnityRows(TREE, expanded, components).find((r) => r.node.name === name);

  it('全部畳むと、自分が移動していてもルートに印が立つ（自分の印に隠さない）', () => {
    expect(row(new Set(), new Set(), 'Root')?.hiddenChange).toBe(true);
  });

  it('子は畳んでもコンポーネントを開いていて、子の下に変更が無ければ印を立てない', () => {
    const tree: readonly UnityNodeDto[] = [
      node('Go', -1, 0, { hasChangedDescendant: true }),
      node('Go/RT', 0, 1, { kind: 'component', mark: 'changed' }),
      node('Child', 0, 1),
    ];
    const go = visibleUnityRows(tree, new Set(), new Set(['Go'])).find((r) => r.node.name === 'Go');
    expect(go?.hiddenChange).toBe(false);
  });

  it('開くと印が 1 段下へ移り、変更のある RectTransform までたどれる', () => {
    // ルートを開いた: ルートはコンポーネントが畳まれているので印が残る。Panel に印が移る
    expect(row(new Set(['Root']), new Set(), 'Root')?.hiddenChange).toBe(true);
    expect(row(new Set(['Root']), new Set(), 'Panel')?.hiddenChange).toBe(true);
    // Panel を開いた: Panel の下はもう見えていて、Panel 自身のコンポーネントは変わっていないので消える
    expect(row(new Set(['Root', 'Panel']), new Set(), 'Panel')?.hiddenChange).toBe(false);
    // Button はコンポーネント（RectTransform）に変更があるので印が立つ
    expect(row(new Set(['Root', 'Panel']), new Set(), 'Button')?.hiddenChange).toBe(true);
    // Button のコンポーネントを開けば印は消え、変更行そのものが見える
    expect(row(new Set(['Root', 'Panel']), new Set(['Button']), 'Button')?.hiddenChange).toBe(false);
    expect(row(new Set(['Root', 'Panel']), new Set(['Button']), 'ButtonRT')?.node.mark).toBe('changed');
  });

  it('コンポーネントを別に畳まないときは、twisty が両方を開閉するので畳んでいれば印が立つ', () => {
    const tree: readonly UnityNodeDto[] = [
      node('Go', -1, 0, { hasChangedDescendant: true }),
      node('Go/RT', 0, 1, { kind: 'component', mark: 'changed' }),
    ];
    expect(visibleUnityRows(tree, new Set())[0]?.hiddenChange).toBe(true);
    expect(visibleUnityRows(tree, new Set(['Go']))[0]?.hiddenChange).toBe(false);
  });
});

/** コンポーネントの開閉ボタン（⚙ 数）と、右端の ● の出し分け（2026-10-10）。 */
describe('コンポーネントの数と、子の変更の印', () => {
  const TREE: readonly UnityNodeDto[] = [
    node('Player', -1, 0, { hasChangedDescendant: true }),
    node('Transform', 0, 1, { kind: 'component' }),
    node('Mover', 0, 1, { kind: 'component', mark: 'changed' }),
    node('Weapon', 0, 1),
    node('Renderer', 3, 2, { kind: 'component' }),
  ];

  it('直下のコンポーネントの数を数える（子の GameObject のコンポーネントは数えない）', () => {
    const rows = visibleUnityRows(TREE, new Set(['Player']), new Set());
    expect(rows.find((r) => r.node.name === 'Player')?.componentCount).toBe(2);
    expect(rows.find((r) => r.node.name === 'Weapon')?.componentCount).toBe(1);
  });

  it('コンポーネントの中だけの変更は、右端の ● ではなくボタン側（hiddenComponentChange）に出す', () => {
    const player = visibleUnityRows(TREE, new Set(), new Set()).find((r) => r.node.name === 'Player');
    expect(player).toMatchObject({ hiddenChildChange: false, hiddenComponentChange: true });
  });

  it('畳まれた子 GameObject の下の変更は右端の ●（hiddenChildChange）', () => {
    const tree: readonly UnityNodeDto[] = [
      node('Root', -1, 0, { hasChangedDescendant: true }),
      node('Root/T', 0, 1, { kind: 'component' }),
      node('Child', 0, 1, { mark: 'changed' }),
    ];
    const root = visibleUnityRows(tree, new Set(), new Set())[0];
    expect(root).toMatchObject({ hiddenChildChange: true, hiddenComponentChange: false });
  });
});
