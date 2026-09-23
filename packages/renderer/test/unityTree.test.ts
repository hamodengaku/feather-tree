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
