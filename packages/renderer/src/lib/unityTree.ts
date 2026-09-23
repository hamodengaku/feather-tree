import type { UnityNodeDto } from '@feathertree/ipc';

/*
 * Unity ヒエラルキーの折り畳みと平坦化（決定 32 / 要件 7）。**純関数だけ。**
 *
 * main から来るのは「平坦な配列＋親の添字」なので、
 * 畳まれた節の下をここで落として、仮想リストにそのまま流せる形にする。
 *
 * `lib/commitGraph.ts`（コミットのレーン計算）と同じ立ち位置で、
 * 取得済みの配列だけから決まる。描画のために IPC を増やさない。
 */

/** 表示する 1 行。 */
export interface UnityRowView {
  readonly node: UnityNodeDto;
  /** 元の配列での添字。選択の同一性に使う。 */
  readonly index: number;
  /** 子を持つか（twisty を出すか）。 */
  readonly hasChildren: boolean;
  readonly expanded: boolean;
}

/**
 * 変更のある節までの経路だけを開いた初期状態（要件 7）。
 *
 * `hasChangedDescendant` は main が計算して載せてくれているので、
 * ここは 1 回のなめで済む（親は必ず子より前にいる）。
 */
export function initialUnityExpansion(nodes: readonly UnityNodeDto[]): ReadonlySet<string> {
  const expanded = new Set<string>();
  for (const node of nodes) {
    if (node.hasChangedDescendant) expanded.add(node.id);
  }
  return expanded;
}

/**
 * 畳まれた節の下を落として、表示する行だけを並べる。
 *
 * 畳まれているかは**親をたどって**決める。親が畳まれていれば、
 * その子が開いていようと表には出ない。
 */
export function visibleUnityRows(
  nodes: readonly UnityNodeDto[],
  expanded: ReadonlySet<string>,
): readonly UnityRowView[] {
  const hasChildren = childFlags(nodes);
  const out: UnityRowView[] = [];
  /** 添字 -> 表に出ているか。親を引くのに使う。 */
  const shown: boolean[] = new Array<boolean>(nodes.length).fill(false);

  nodes.forEach((node, index) => {
    const parentShown = node.parent < 0 || shown[node.parent] === true;
    const parentOpen = node.parent < 0 || expanded.has(nodes[node.parent]?.id ?? '');
    const visible = parentShown && parentOpen;
    shown[index] = visible;
    if (!visible) return;
    out.push({
      node,
      index,
      hasChildren: hasChildren[index] === true,
      expanded: expanded.has(node.id),
    });
  });

  return out;
}

/** その節を見せるために開かなければならない祖先を全部開く。 */
export function expandToNode(
  nodes: readonly UnityNodeDto[],
  expanded: ReadonlySet<string>,
  index: number,
): ReadonlySet<string> {
  const next = new Set(expanded);
  let cursor = nodes[index]?.parent ?? -1;
  while (cursor >= 0) {
    const parent = nodes[cursor];
    if (parent === undefined) break;
    next.add(parent.id);
    cursor = parent.parent;
  }
  return next;
}

function childFlags(nodes: readonly UnityNodeDto[]): readonly boolean[] {
  const flags = new Array<boolean>(nodes.length).fill(false);
  for (const node of nodes) {
    if (node.parent >= 0) flags[node.parent] = true;
  }
  return flags;
}
