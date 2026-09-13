import { spawn } from 'node:child_process';
import { buildGitEnv } from './gitEnvironment.js';
import { GitCancelledError, GitNotFoundError, GitTimeoutError } from './errors.js';
import { killTree } from './killTree.js';

export interface GitCommand {
  readonly gitPath: string;
  readonly cwd: string;
  /**
   * 引数は必ず配列で渡す。文字列連結は空白・日本語・記号を含むパスで事故になる。
   * 前置オプション（READ_PREFIX 等）を含めた完全な引数列。
   */
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  /**
   * このコマンドにだけ足す環境変数（docs/02-git-command-map.md 共通オプション）。
   * 共通の固定値（GIT_TERMINAL_PROMPT 等）は上書きできない。
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface GitExit {
  readonly code: number;
  readonly elapsedMs: number;
  readonly stderr: string;
}

/** 巨大出力を Buffer のまま逐次受け取るためのコンシューマ。 */
export interface ChunkSink<T> {
  push(chunk: Buffer): void;
  finish(): T;
}

/** stderr を保持する上限。git の進捗出力で無制限に膨らむのを防ぐ。 */
const STDERR_LIMIT = 64 * 1024;

interface RunHooks {
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderrLine?: (line: string) => void;
}

/**
 * git を 1 回実行する。1 API = 1 プロセスが原則（docs/02-git-command-map.md）。
 *
 * stdout と stderr は必ず並行に読む。片方を放置するとパイプが満杯になり git が停止する。
 */
async function run(cmd: GitCommand, signal: AbortSignal | undefined, hooks: RunHooks): Promise<GitExit> {
  const startedAt = Date.now();

  const child = spawn(cmd.gitPath, [...cmd.args], {
    cwd: cmd.cwd,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildGitEnv(process.env, cmd.env),
  });

  let stderrText = '';
  let stderrCarry = '';
  let cancelled = false;
  let timedOut = false;

  const appendStderr = (text: string): void => {
    if (stderrText.length < STDERR_LIMIT) {
      stderrText += text.slice(0, STDERR_LIMIT - stderrText.length);
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => hooks.onStdout?.(chunk));

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    appendStderr(text);
    if (!hooks.onStderrLine) return;
    // git は進捗を CR で上書きするため CR も行区切りとして扱う
    stderrCarry += text;
    const parts = stderrCarry.split(/\r\n|\r|\n/);
    stderrCarry = parts.pop() ?? '';
    for (const line of parts) {
      if (line.length > 0) hooks.onStderrLine(line);
    }
  });

  const timer =
    cmd.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          void killTree(child);
        }, cmd.timeoutMs);

  const onAbort = (): void => {
    cancelled = true;
    void killTree(child);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted === true) onAbort();

  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') reject(new GitNotFoundError(cmd.gitPath, err));
        else reject(err);
      });
      child.once('close', (exitCode) => resolve(exitCode ?? -1));
    });

    if (hooks.onStderrLine && stderrCarry.length > 0) hooks.onStderrLine(stderrCarry);
    if (timedOut) throw new GitTimeoutError(cmd.timeoutMs ?? 0);
    if (cancelled) throw new GitCancelledError();

    return { code, elapsedMs: Date.now() - startedAt, stderr: stderrText };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 小さい出力専用。全体を文字列で受け取る。 */
export async function runGitText(
  cmd: GitCommand,
  signal?: AbortSignal,
): Promise<{ exit: GitExit; stdout: string }> {
  const chunks: Buffer[] = [];
  const exit = await run(cmd, signal, { onStdout: (chunk) => chunks.push(chunk) });
  return { exit, stdout: Buffer.concat(chunks).toString('utf8') };
}

/**
 * 巨大出力用。stdout を Buffer のまま sink に渡す。
 * setEncoding は使わない（マルチバイト境界とパース位置がずれる）。
 */
export async function runGitStream<T>(
  cmd: GitCommand,
  sink: ChunkSink<T>,
  signal?: AbortSignal,
): Promise<{ exit: GitExit; result: T }> {
  const exit = await run(cmd, signal, { onStdout: (chunk) => sink.push(chunk) });
  return { exit, result: sink.finish() };
}

/** fetch / push / checkout の進捗を受け取る。git は進捗を stderr に出す。 */
export async function runGitWithProgress(
  cmd: GitCommand,
  onProgress: (line: string) => void,
  signal?: AbortSignal,
): Promise<GitExit> {
  return run(cmd, signal, { onStderrLine: onProgress });
}
