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
  /** 子を持つか（twisty を出すか）。componentsShown を渡したときは「コンポーネント以外の子」だけを数える。 */
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  /** コンポーネントを持つか（componentsShown を渡したときだけ意味を持つ）。 */
  readonly hasComponents: boolean;
  /** 畳まれているコンポーネントの中に変更があるか（行の印に使う）。 */
  readonly hiddenComponentChange: boolean;
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
 *
 * `componentsShown` を渡すと、**コンポーネントは別に畳む**（2026-10-02、利用者の指示）。
 * twisty（`expanded`）が開くのは子の GameObject / PrefabInstance だけで、コンポーネントは
 * その GameObject が `componentsShown` に入っている（＝名前をクリックした）ときだけ出る。
 * 渡さなければ従来どおり、twisty でコンポーネントも子も一緒に開く。
 */
export function visibleUnityRows(
  nodes: readonly UnityNodeDto[],
  expanded: ReadonlySet<string>,
  componentsShown?: ReadonlySet<string>,
): readonly UnityRowView[] {
  const separate = componentsShown !== undefined;
  const flags = childFlags(nodes);
  const out: UnityRowView[] = [];
  /** 添字 -> 表に出ているか。親を引くのに使う。 */
  const shown: boolean[] = new Array<boolean>(nodes.length).fill(false);

  nodes.forEach((node, index) => {
    const parent = node.parent < 0 ? undefined : nodes[node.parent];
    const parentShown = node.parent < 0 || shown[node.parent] === true;
    const parentOpen =
      parent === undefined ||
      (separate && node.kind === 'component'
        ? componentsShown.has(parent.id)
        : expanded.has(parent.id));
    const visible = parentShown && parentOpen;
    shown[index] = visible;
    if (!visible) return;
    const componentsOpen = separate && componentsShown.has(node.id);
    out.push({
      node,
      index,
      hasChildren: separate ? flags.otherChildren[index] === true : flags.anyChildren[index] === true,
      expanded: expanded.has(node.id),
      hasComponents: flags.components[index] === true,
      hiddenComponentChange: separate && !componentsOpen && flags.changedComponents[index] === true,
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

interface ChildFlags {
  readonly anyChildren: readonly boolean[];
  /** コンポーネント以外（GameObject / PrefabInstance）の子を持つか。 */
  readonly otherChildren: readonly boolean[];
  readonly components: readonly boolean[];
  /** 直下のコンポーネントのどれかに変更の印があるか。 */
  readonly changedComponents: readonly boolean[];
}

function childFlags(nodes: readonly UnityNodeDto[]): ChildFlags {
  const anyChildren = new Array<boolean>(nodes.length).fill(false);
  const otherChildren = new Array<boolean>(nodes.length).fill(false);
  const components = new Array<boolean>(nodes.length).fill(false);
  const changedComponents = new Array<boolean>(nodes.length).fill(false);
  for (const node of nodes) {
    if (node.parent < 0) continue;
    anyChildren[node.parent] = true;
    if (node.kind === 'component') {
      components[node.parent] = true;
      if (node.mark !== 'same' || node.hasChangedDescendant) changedComponents[node.parent] = true;
    } else {
      otherChildren[node.parent] = true;
    }
  }
  return { anyChildren, otherChildren, components, changedComponents };
}
