export type FtErrorKind =
  | 'git-not-found'
  | 'git-failed'
  | 'not-a-repository'
  | 'invalid-path'
  | 'cancelled'
  | 'internal';

export interface MappedError {
  readonly kind: FtErrorKind;
  /** UI にそのまま出せる日本語。 */
  readonly message: string;
  /** git の stderr 原文。折りたたみ表示に使う。 */
  readonly detail?: string;
  readonly exitCode?: number;
}

interface Rule {
  readonly test: RegExp;
  readonly message: string;
}

/**
 * git の stderr を日本語メッセージへ写す（docs/02-git-command-map.md エラーマッピング）。
 * 原文は必ず detail として残す。訳して情報を失わせない。
 */
const RULES: readonly Rule[] = [
  {
    test: /could not read Username|Authentication failed|Permission denied \(publickey\)|fatal: Authentication/i,
    message: '認証に失敗しました。Git Credential Manager / SSH エージェントの設定を確認してください。',
  },
  {
    test: /non-fast-forward|rejected.*fetch first|Updates were rejected/i,
    message: 'リモートに新しいコミットがあります。先に取得（fetch / pull）してください。',
  },
  {
    /*
     * 切替（#12）だけでなく **stash の展開（#29 / #30）でも出る**ので、
     * 文言から「切り替え」を外した（2026-09-20、決定 31）。
     * どちらの操作でも打つ手は同じ（先にコミットするか、退避してから再実行する）。
     */
    test: /Your local changes to the following files would be overwritten|Please commit your changes or stash them/i,
    message:
      '未コミットの変更が上書きされるため実行できません。先にコミットするか、退避してからやり直してください。',
  },
  /*
   * stash（決定 31 / 対応表 #27〜#31）。
   *
   * **`CONFLICT` の行より前に置く**。`pop` がコンフリクトした場合は
   * 既存の CONFLICT の文言で足りるが、下の 4 つはそれぞれ別の手を打つ必要があり、
   * 「git の実行に失敗しました。」では何をすればよいか分からない。
   */
  {
    // #27 の実測表 5 行目。**stash 自体はできている**ので、そう書かないと二重に保存される
    test: /Cannot remove worktree changes/i,
    message:
      'ステージした変更を作業ツリーから取り除けませんでした（同じ箇所に未ステージの変更が重なっています）。' +
      'stash は作成済みです。残った変更を確認してください。',
  },
  {
    test: /No staged changes/i,
    message: 'ステージした変更がありません。stash に保存するものをステージしてください。',
  },
  {
    test: /You do not have the initial commit yet/i,
    message: 'まだコミットが 1 つもないため実行できません。先にコミットしてください。',
  },
  {
    test: /is not a stash reference|stash@\{[0-9]+\} is not a valid reference|log for .stash. only has/i,
    message: 'その stash が見つかりません。一覧を更新してからやり直してください。',
  },
  {
    test: /index\.lock|Unable to create .*\.lock/i,
    message: '他の git プロセスが実行中です。少し待ってからやり直してください。',
  },
  {
    test: /CONFLICT|Automatic merge failed|needs merge/i,
    message: 'コンフリクトが発生しました。競合を解決してください。',
  },
  {
    test: /smudge filter lfs failed|git-lfs.*not found|external filter .*lfs.* failed/i,
    message: 'Git LFS の処理に失敗しました。Git LFS が導入されているか確認してください。',
  },
  {
    test: /not a git repository/i,
    message: 'git リポジトリではありません。',
  },
  {
    test: /pathspec .* did not match/i,
    message: '指定されたパスが見つかりません。一覧を更新してください。',
  },
  {
    test: /a branch named .* already exists/i,
    message: '同名のブランチが既に存在します。',
  },
  {
    test: /not a valid (branch|ref|object) name|invalid reference|is not a commit/i,
    message: 'ブランチ元またはブランチ名が正しくありません。',
  },
  {
    test: /destination path .* already exists and is not an empty directory/i,
    message: '保存先に同名のフォルダがあり、空ではありません。フォルダ名を変えてください。',
  },
  {
    test: /Repository not found|does not appear to be a git repository|Could not resolve host/i,
    message: 'リポジトリが見つかりません。URL を確認してください。',
  },
];

export function mapGitStderr(stderr: string, exitCode: number): MappedError {
  const detail = stderr.trim();

  for (const rule of RULES) {
    if (rule.test.test(detail)) {
      const kind: FtErrorKind = /not a git repository/i.test(detail) ? 'not-a-repository' : 'git-failed';
      return { kind, message: rule.message, ...(detail.length > 0 ? { detail } : {}), exitCode };
    }
  }

  return {
    kind: 'git-failed',
    message: 'git の実行に失敗しました。',
    ...(detail.length > 0 ? { detail } : {}),
    exitCode,
  };
}
