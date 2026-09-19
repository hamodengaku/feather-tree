import type { BranchDto } from '@feathertree/ipc';

/**
 * ブランチ名をスラッシュで階層化して、表示する行の配列に変換する。
 *
 * Svelte に依存しない純関数として書いてある（単体テストのため）。
 * リモートは shortName が 'origin/feature/a' なので、先頭セグメントが
 * そのままリモート名の階層になる。特別扱いは不要。
 */

export type BranchScope = 'local' | 'remote';

export interface BranchFolderRow {
  readonly kind: 'folder';
  /** 表示するラベル。圧縮されたときは 'feature/ui' のように複数セグメントになる。 */
  readonly label: string;
  /** 名前空間なしのフルパス。'feature/ui' */
  readonly path: string;
  /** 展開集合に入れるキー。'local:feature/ui' */
  readonly key: string;
  readonly depth: number;
  readonly expanded: boolean;
  /**
   * 同名のブランチを兼ねるノード。git は refs/heads/feature と refs/heads/feature/x の
   * 共存を禁じるので通常は null。壊れた ref でも行が消えないようにするための逃げ道。
   */
  readonly branch: BranchDto | null;
}

export interface BranchLeafRow {
  readonly kind: 'branch';
  /** ブランチ名の最終セグメント。 */
  readonly label: string;
  readonly depth: number;
  readonly branch: BranchDto;
}

export type BranchTreeRow = BranchFolderRow | BranchLeafRow;

interface Node {
  readonly segment: string;
  readonly path: string;
  branch: BranchDto | null;
  readonly children: Map<string, Node>;
}

function newNode(segment: string, path: string): Node {
  return { segment, path, branch: null, children: new Map() };
}

/**
 * 名前順。locale に依存すると環境によって並びが変わるので、
 * 小文字化した比較 → コードポイント比較の 2 段で決める。
 */
function compareName(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** フォルダを先、次にブランチ。それぞれ名前順。 */
function sortChildren(node: Node): Node[] {
  return [...node.children.values()].sort((a, b) => {
    const aFolder = a.children.size > 0;
    const bFolder = b.children.size > 0;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return compareName(a.segment, b.segment);
  });
}

/**
 * 子がちょうど 1 つで、その子もフォルダなら親に畳む。
 * 'feature/ui/fix' しか無ければ 'feature/ui' の 1 行 + 葉 'fix' になる。
 * 子が葉のときは畳まない（葉のラベルは必ずブランチ名の最終セグメントにする）。
 */
function compress(node: Node): { label: string; node: Node } {
  let label = node.segment;
  let current = node;
  for (;;) {
    if (current.branch !== null || current.children.size !== 1) break;
    const only = [...current.children.values()][0];
    if (only === undefined || only.children.size === 0 || only.branch !== null) break;
    label = label + '/' + only.segment;
    current = only;
  }
  return { label, node: current };
}

export function buildBranchTree(
  branches: readonly BranchDto[],
  expanded: ReadonlySet<string>,
  scope: BranchScope,
): readonly BranchTreeRow[] {
  const root = newNode('', '');

  for (const branch of branches) {
    const segments = branch.shortName.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    let node = root;
    let path = '';
    for (const segment of segments) {
      path = path.length === 0 ? segment : path + '/' + segment;
      let child = node.children.get(segment);
      if (child === undefined) {
        child = newNode(segment, path);
        node.children.set(segment, child);
      }
      node = child;
    }
    node.branch = branch;
  }

  const rows: BranchTreeRow[] = [];

  const walk = (node: Node, depth: number): void => {
    for (const child of sortChildren(node)) {
      if (child.children.size === 0) {
        // 葉。children が空になるのは insert でブランチを置いたノードだけ
        if (child.branch !== null) {
          rows.push({ kind: 'branch', label: child.segment, depth, branch: child.branch });
        }
        continue;
      }
      const folder = compress(child);
      const key = scope + ':' + folder.node.path;
      const isExpanded = expanded.has(key);
      rows.push({
        kind: 'folder',
        label: folder.label,
        path: folder.node.path,
        key,
        depth,
        expanded: isExpanded,
        branch: folder.node.branch,
      });
      if (isExpanded) walk(folder.node, depth + 1);
    }
  };

  walk(root, 0);
  return rows;
}

/**
 * あるパスを開くときに展開集合へ足すキー。通過するすべての前置きを含める。
 * 'feature/ui' → ['local:feature', 'local:feature/ui']
 *
 * 前置きまで入れておくと、兄弟ブランチが増えて圧縮が解けたときにも
 * 保存した展開状態が意図どおりに効く。
 */
export function expandKeys(scope: BranchScope, path: string): string[] {
  const keys: string[] = [];
  let acc = '';
  for (const segment of path.split('/')) {
    if (segment.length === 0) continue;
    acc = acc.length === 0 ? segment : acc + '/' + segment;
    keys.push(scope + ':' + acc);
  }
  return keys;
}

/** あるパスを畳むときに消すキーか（自身とその子孫）。 */
export function isUnderPath(key: string, scope: BranchScope, path: string): boolean {
  const prefix = scope + ':' + path;
  return key === prefix || key.startsWith(prefix + '/');
}

/**
 * クリックの 2 打目以降か。
 *
 * この一覧はブランチ行を「ダブルクリックで切り替え」る作りなので、フォルダ行もつい 2 回押される。
 * 2 打目まで拾うと開いた直後に閉じてしまい、利用者からは「押しても無反応」に見える。
 *
 * MouseEvent.detail は連続クリック回数。キーボード（Enter / Space）での実行では 0 になるので、
 * 「1 より大きい」で弾けば操作を取りこぼさない。
 */
export function isRepeatClick(detail: number): boolean {
  return detail > 1;
}

/**
 * 保存形式（配列）を検索用の集合に変える。
 * 生成をこのモジュールに閉じているのは、renderer の .svelte / .svelte.ts では
 * 素の Set を持てない（svelte/prefer-svelte-reactivity）ため。
 */
export function toExpandedSet(paths: readonly string[]): ReadonlySet<string> {
  return new Set(paths);
}

/** path と、そこへ至る前置きをすべて開いた新しい配列。 */
export function withExpanded(
  paths: readonly string[],
  scope: BranchScope,
  path: string,
): string[] {
  const next = new Set(paths);
  for (const key of expandKeys(scope, path)) next.add(key);
  return [...next];
}

/** path と、その子孫を畳んだ新しい配列。 */
export function withCollapsed(
  paths: readonly string[],
  scope: BranchScope,
  path: string,
): string[] {
  return paths.filter((key) => !isUnderPath(key, scope, path));
}

/**
 * ブランチ名の祖先フォルダのキー。現在のブランチへの経路を自動で開くのに使う。
 * 'feature/ui/fix' → ['local:feature', 'local:feature/ui']
 */
export function ancestorKeys(scope: BranchScope, shortName: string): string[] {
  const segments = shortName.split('/').filter((s) => s.length > 0);
  segments.pop();
  return expandKeys(scope, segments.join('/'));
}

/**
 * 「現在のブランチへの経路を自動で開く」の判断。
 *
 * ロジックを純関数にしてあるのは、**この判断が壊れたことを検出できるようにする**ため。
 * renderer にコンポーネントのテスト基盤は無い（純 TS のロジックテストだけ）ので、
 * .svelte の $effect の中に判断を書くと、誰も見ていない場所になる。
 *
 * 実際に起きた事故: `<BranchPane />` を表示モードの分岐の両枝に重複して書いていたため、
 * モードを切り替えるたびにコンポーネントが作り直され、シード済みの記録（`seeded`）が
 * 初期化されて、**利用者が意図的に畳んだフォルダが開き直されていた**。
 * 記録はコンポーネントの生存期間に結びつくので、コンポーネントを生かし続けること自体が
 * 仕様の一部になる（App.svelte 側の責務）。
 */
export interface SeedInput {
  /** アクティブなタブ。null ならまだ何も開いていない。 */
  readonly sessionId: string | null;
  /** status 由来の現在ブランチ。detached や未取得なら null。 */
  readonly branch: string | null;
  /** 設定を読み終えているか。読む前に保存すると既定値で上書きしてしまう。 */
  readonly settingsReady: boolean;
  /** 現在の展開集合（保存形式の配列）。 */
  readonly expanded: readonly string[];
  /** すでにシード済みの印（`seedMark` の戻り値）。 */
  readonly seeded: readonly string[];
}

export interface SeedDecision {
  /** シード済みとして記録する印。null なら今回は何もしない（記録もしない）。 */
  readonly mark: string | null;
  /** 保存すべき新しい展開集合。null なら保存不要（すでに開いている）。 */
  readonly expanded: readonly string[] | null;
}

const NO_SEED: SeedDecision = { mark: null, expanded: null };

/** 「リポジトリ × ブランチ」の組を 1 つの印にする。 */
export function seedMark(sessionId: string, branch: string): string {
  return JSON.stringify([sessionId, branch]);
}

/**
 * シードするか、するなら何を保存するかを決める。
 *
 * 一度シードした組は二度とシードしない（`mark` を記録させる）。これが
 * 「ユーザーが畳み直したものを開き直さない」の中身で、**開く必要が無かった場合でも
 * 記録する**のが要点。記録しないと、畳まれた直後にもう一度開きにいってしまう。
 */
export function planCurrentBranchSeed(input: SeedInput): SeedDecision {
  if (input.sessionId === null || input.branch === null || !input.settingsReady) return NO_SEED;

  const mark = seedMark(input.sessionId, input.branch);
  if (input.seeded.includes(mark)) return NO_SEED;

  const missing = ancestorKeys('local', input.branch).filter((key) => !input.expanded.includes(key));
  return { mark, expanded: missing.length === 0 ? null : [...input.expanded, ...missing] };
}
