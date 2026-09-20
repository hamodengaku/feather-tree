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
  readonly committerName: string;
  readonly committerEmail: string;
  /** ISO 8601。rebase や cherry-pick の後は authoredAt と食い違う。 */
  readonly committedAt: string;
  readonly subject: string;
  /**
   * 件名を除いた本文。無ければ空文字。
   *
   * 一覧の取得（#20）でまとめて取る。コミットを選ぶたびに `show -s` を打つと
   * 行を選ぶだけで git が 2 プロセス走るため（docs/02-git-command-map.md の「履歴」節）。
   */
  readonly body: string;
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

/* ------------------------------------------------ コンフリクト（マーカーの表示と採用） */

/**
 * 1 つの衝突ブロック（`<<<<<<<` 〜 `>>>>>>>`）の骨格。
 *
 * 本文そのものは持たず、**行番号だけ**を持つ（1 始まり）。本文は同じ解析結果の
 * `lines` から切り出す。二重に持つと、採用のときにどちらが正かが曖昧になる。
 */
export interface ConflictBlock {
  /** ファイル内で何番目の衝突か（0 始まり）。 */
  readonly index: number;
  /** `<<<<<<<` の行番号。 */
  readonly startLine: number;
  /** `|||||||` の行番号。diff3 スタイルでなければ null。 */
  readonly baseLine: number | null;
  /** `=======` の行番号。 */
  readonly separatorLine: number;
  /** `>>>>>>>` の行番号。 */
  readonly endLine: number;
  /** `<<<<<<< HEAD` の `HEAD`。ラベルが無ければ空文字。 */
  readonly ourLabel: string;
  readonly baseLabel: string | null;
  readonly theirLabel: string;
  readonly ourCount: number;
  readonly baseCount: number;
  readonly theirCount: number;
}

/**
 * 1 ブロックの採り方。
 * `ours-theirs` / `theirs-ours` は**両方を残す**（違いは挿入の順序だけ）。
 */
export type ConflictChoice = 'ours' | 'theirs' | 'ours-theirs' | 'theirs-ours';

export type ConflictLineKind = 'context' | 'marker' | 'ours' | 'base' | 'theirs';

export interface ConflictLine {
  readonly kind: ConflictLineKind;
  readonly text: string;
  /** 作業ツリーのファイル内の行番号（1 始まり）。 */
  readonly lineNo: number;
}

/** 画面に出す 1 衝突分。diff の hunk に相当する。 */
export interface ConflictSection {
  readonly index: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly ourLabel: string;
  readonly theirLabel: string;
  readonly baseLabel: string | null;
  readonly ourCount: number;
  readonly theirCount: number;
  /** 文脈行・マーカー行・各側の本文を並べたもの。 */
  readonly lines: readonly ConflictLine[];
  /** 行数上限で途中から落とした。 */
  readonly truncated: boolean;
}

export interface ConflictFile {
  readonly path: string;
  readonly binary: boolean;
  /** マーカーが閉じていない／入れ子。採用は行わせない（外部ツールに委ねる）。 */
  readonly malformed: boolean;
  readonly sections: readonly ConflictSection[];
  readonly truncated: boolean;
}

/**
 * stash スタックの 1 件（対応表 #28、決定 31）。
 *
 * **参照の渡し方を読み書きで違える**ので、同じ 1 件について 2 つの識別子を持つ:
 *  - `ref`（`stash@{0}`）は `apply` / `pop` / `drop` へ渡すもの。**番号は drop / pop のたびにずれる**
 *  - `oid` は `stash show` / `diff` へ渡すもの。一覧が古くても別の stash を読まない
 *
 * `pop` / `drop` が生の oid を受け付けない（`is not a stash reference`）ので、
 * 片方だけでは足りない（docs/02-git-command-map.md の #27〜#31 の注記）。
 */
export interface StashEntry {
  /** `stash@{n}` の n。新しいものが 0。 */
  readonly index: number;
  /** `stash@{n}`（`%gd`）。書き込み系に渡す参照。 */
  readonly ref: string;
  /** stash コミットの oid（`%H`）。読み取り系に渡す参照。 */
  readonly oid: string;
  /**
   * 親の oid（`%P`）。
   *
   * **2 つ**なら HEAD と index コミット（このアプリが作る `--staged` の stash）。
   * **3 つ**なら 3 番目が未追跡コミット（外部で `-u` 付きに作られたもの）で、
   * そこにしか無いファイルは `<oid>^ <oid>` の diff に現れない（#46 の注記）。
   */
  readonly parents: readonly string[];
  /** ISO 8601。 */
  readonly authoredAt: string;
  /** reflog の件名（`%gs`）。`On main: 退避のメモ` の形。 */
  readonly message: string;
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
