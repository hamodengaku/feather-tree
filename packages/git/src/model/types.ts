/**
 * git 操作層のデータモデル。
 * すべて不変。UI 都合の派生値（表示名・アイコン種別など）はここに置かない。
 */

/** git status --porcelain=v2 の XY 各 1 文字。'.' は「変化なし」。 */
export type StatusCode = '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!';

export type EntryKind = 'ordinary' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';

export interface FileEntry {
  readonly kind: EntryKind;
  /** リポジトリルート相対。区切りは常に '/'。 */
  readonly path: string;
  /** kind === 'renamed' のときの元パス。 */
  readonly origPath?: string;
  /** インデックス側の状態（X）。 */
  readonly staged: StatusCode;
  /** 作業ツリー側の状態（Y）。 */
  readonly worktree: StatusCode;
  /** rename / copy の類似度（%）。 */
  readonly score?: number;
}

export interface HeadInfo {
  /** コミットが 1 つも無いリポジトリでは null。 */
  readonly oid: string | null;
  /** detached HEAD では null。 */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
}

export interface StatusCounts {
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly unmerged: number;
  readonly total: number;
}

export interface StatusSnapshot {
  readonly head: HeadInfo;
  readonly entries: readonly FileEntry[];
  readonly counts: StatusCounts;
}

export interface RepositoryLocation {
  /** ワークツリーのルート（絶対パス）。 */
  readonly root: string;
  /** .git ディレクトリ（絶対パス）。 */
  readonly gitDir: string;
}

export interface BranchRef {
  /** refs/heads/main のような完全参照名。 */
  readonly refName: string;
  /** main / origin/main のような短縮名。 */
  readonly shortName: string;
  readonly isRemote: boolean;
  readonly isHead: boolean;
  readonly oid: string;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  /** 上流が削除済み。 */
  readonly gone: boolean;
  /** ISO 8601。 */
  readonly committedAt: string;
  readonly subject: string;
}

export interface CommitSummary {
  readonly oid: string;
  readonly shortOid: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  /** ISO 8601。 */
  readonly authoredAt: string;
  readonly subject: string;
}

export type DiffLineKind = 'context' | 'added' | 'removed' | 'no-newline';

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** 先頭の +/- を除いた本文。 */
  readonly text: string;
  readonly oldLineNo: number | null;
  readonly newLineNo: number | null;
}

export interface DiffHunk {
  /** @@ ... @@ の行そのもの。 */
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export interface FileDiff {
  readonly path: string;
  /** rename の場合の元パス。 */
  readonly oldPath: string | null;
  readonly binary: boolean;
  readonly hunks: readonly DiffHunk[];
  /** 行数上限で打ち切った。 */
  readonly truncated: boolean;
  /**
   * `diff --git` 行から最初の `@@` 直前までの生の行（対応表 #33 / #34）。
   *
   * パッチ再構成に必須。`new file mode` / `index abc..def` / `similarity index` /
   * C クォートされたパスは自前で復元できないため、1 行も加工せずそのまま持つ。
   * 未追跡ファイルの合成 diff は空配列になり、これが「パッチ生成不可」の判定を兼ねる。
   */
  readonly preamble: readonly string[];
}

/** git show --name-status の 1 行。 */
export interface CommitFileChange {
  /** A / M / D / R / C / T など。 */
  readonly status: string;
  readonly path: string;
  readonly origPath: string | null;
}

export interface GitVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}
