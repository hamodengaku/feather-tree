import type { FileEntry, StatusCounts, StatusSnapshot } from '@feathertree/git';

/**
 * 'changes' は「ステージされていない変更すべて」（未ステージ + 未追跡 + 未マージ）。
 * SourceTree / Fork 風の 2 リスト構成（ステージ済み / 変更）を 1 回の問い合わせで作るため。
 */
export type StatusGroup = 'staged' | 'unstaged' | 'untracked' | 'unmerged' | 'changes';

export interface StatusFilter {
  readonly group?: StatusGroup;
  /** パスの部分一致（大文字小文字を無視）。 */
  readonly query?: string;
}

export interface StatusPage {
  readonly offset: number;
  readonly entries: readonly FileEntry[];
  /** フィルタ適用後の総件数。 */
  readonly filteredTotal: number;
}

export interface StatusSummary {
  readonly counts: StatusCounts;
  readonly hasSnapshot: boolean;
}

/**
 * スナップショットの正本は main 側に置き、renderer には可視範囲だけ返す
 * （docs/01-architecture.md 6 章）。この関数群がその境界を作る。
 *
 * 10 万件のパス配列を IPC に流さないための要。
 */
export function filterEntries(snapshot: StatusSnapshot, filter: StatusFilter = {}): readonly FileEntry[] {
  const query = filter.query?.toLowerCase();

  return snapshot.entries.filter((e) => {
    if (filter.group !== undefined && !inGroup(e, filter.group)) return false;
    if (query !== undefined && query.length > 0 && !e.path.toLowerCase().includes(query)) return false;
    return true;
  });
}

export function pageEntries(
  snapshot: StatusSnapshot,
  offset: number,
  limit: number,
  filter: StatusFilter = {},
): StatusPage {
  const filtered = filterEntries(snapshot, filter);
  const start = Math.max(0, offset);
  return {
    offset: start,
    entries: filtered.slice(start, start + Math.max(0, limit)),
    filteredTotal: filtered.length,
  };
}

/** 操作対象の指定。パス配列を renderer から送り返させないための型。 */
export type OperationTarget =
  | { readonly kind: 'all' }
  | { readonly kind: 'filtered'; readonly filter: StatusFilter }
  | { readonly kind: 'paths'; readonly paths: readonly string[] };

/** `kind: 'paths'` で受け付ける最大件数。超えたら filtered を使わせる。 */
export const MAX_EXPLICIT_PATHS = 5000;

/**
 * 操作対象をパス一覧へ解決する。
 * 'all' / 'filtered' は main 側のスナップショットから組み立てるので IPC を消費しない。
 */
export function resolveTarget(snapshot: StatusSnapshot, target: OperationTarget): readonly string[] {
  if (target.kind === 'paths') return target.paths;
  const filter = target.kind === 'filtered' ? target.filter : {};
  return filterEntries(snapshot, filter).map((e) => e.path);
}

function inGroup(entry: FileEntry, group: StatusGroup): boolean {
  switch (group) {
    case 'untracked':
      return entry.kind === 'untracked';
    case 'unmerged':
      return entry.kind === 'unmerged';
    case 'staged':
      return (entry.kind === 'ordinary' || entry.kind === 'renamed') && entry.staged !== '.';
    case 'unstaged':
      return (entry.kind === 'ordinary' || entry.kind === 'renamed') && entry.worktree !== '.';
    case 'changes':
      if (entry.kind === 'untracked' || entry.kind === 'unmerged') return true;
      return (entry.kind === 'ordinary' || entry.kind === 'renamed') && entry.worktree !== '.';
  }
}
