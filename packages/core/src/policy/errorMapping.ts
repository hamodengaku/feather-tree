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
    test: /Your local changes to the following files would be overwritten|Please commit your changes or stash them/i,
    message: '未コミットの変更があるため切り替えできません。コミットまたは stash してください。',
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
