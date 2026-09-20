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
  /**
   * 失敗の理由が stdout 側に出るコマンドだけが渡す（既定は空）。
   *
   * `merge` / `pull` の競合は **`CONFLICT (content): ...` / `Automatic merge failed` を
   * stdout に書き、stderr は空**（実測。docs/02-git-command-map.md エラーマッピング）。
   * stderr しか見ないと「git の実行に失敗しました」としか言えない。
   *
   * 全コマンドで渡さないのは、`status` や `log` のように stdout が本文（数万行）に
   * なりうるものがあるため。**エラー文の出所が stdout だと分かっているものだけ**に足す。
   */
  readonly stdout: string;

  constructor(args: readonly string[], exitCode: number, stderr: string, stdout = '') {
    super(`git ${args.join(' ')} が終了コード ${exitCode} で失敗しました`);
    this.name = 'GitCommandError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.stdout = stdout;
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
