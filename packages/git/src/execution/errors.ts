/**
 * git 操作層が投げる例外。
 * 上位層（core）でここを Result 型へ変換する。git 層は Result を知らない。
 */

export class GitNotFoundError extends Error {
  readonly gitPath: string;

  constructor(gitPath: string, cause?: unknown) {
    super(`git を実行できませんでした: ${gitPath}`);
    this.name = 'GitNotFoundError';
    this.gitPath = gitPath;
    if (cause !== undefined) this.cause = cause;
  }
}

export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(`git ${args.join(' ')} が終了コード ${exitCode} で失敗しました`);
    this.name = 'GitCommandError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * 作業ディレクトリ（リポジトリのフォルダ）が存在しない。
 *
 * Windows では **cwd が無い場合も spawn は ENOENT を返す**ため、git 本体が
 * 見つからない場合と区別が付かない。区別せずに GitNotFoundError へ写すと、
 * リポジトリのフォルダを移動・削除しただけで「Git for Windows を導入してください」と
 * 表示され、利用者を完全に誤った方向へ誘導する。
 *
 * GitCommandError を継承しているのは、上位層（core の toMappedError）が
 * 既に GitCommandError を拾う枝を持っているため。新しい枝を足さなくても
 * 「git を実行できませんでした」系の誤案内にはならず、stderr 相当の説明文が
 * そのまま詳細として表示される。専用の日本語メッセージを出したくなったら
 * core 側で instanceof GitWorkingDirectoryError を先に見ればよい。
 */
export class GitWorkingDirectoryError extends GitCommandError {
  readonly cwd: string;

  constructor(cwd: string, cause?: unknown) {
    super([], -1, `作業フォルダが見つかりません: ${cwd}`);
    this.name = 'GitWorkingDirectoryError';
    this.message = `リポジトリのフォルダが見つかりません: ${cwd}`;
    this.cwd = cwd;
    if (cause !== undefined) this.cause = cause;
  }
}

export class GitCancelledError extends Error {
  constructor() {
    super('git の実行が中断されました');
    this.name = 'GitCancelledError';
  }
}

export class GitTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`git の実行が ${timeoutMs}ms で打ち切られました`);
    this.name = 'GitTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class GitParseError extends Error {
  constructor(message: string) {
    super(`git の出力を解釈できませんでした: ${message}`);
    this.name = 'GitParseError';
  }
}
