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
