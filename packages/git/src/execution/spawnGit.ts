import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { buildGitEnv } from './gitEnvironment.js';
import { registerGitProcess } from './childRegistry.js';
import {
  GitCancelledError,
  GitNotFoundError,
  GitTimeoutError,
  GitWorkingDirectoryError,
} from './errors.js';
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

/*
 * 読み取り系のタイムアウト（docs/02-git-command-map.md キャンセル・タイムアウト節の表）。
 *
 * **値はこの層に閉じる。** GitContext に載せると core 全体の型に波及する割に、
 * 呼び出し側が意味のある値を決められない（どのコマンドかを知っているのはここだけ）。
 *
 * 書き込み系・通信系には付けない。push / clone は巨大リポジトリなら数時間かかりうる、
 * 「人が待つと決めた操作」であり、打ち切りは利用者の明示的なキャンセルで行う。
 */

/**
 * #1 rev-parse / #32 --version。
 *
 * rev-parse はオブジェクト DB も作業ツリーも読まないので本来は一瞬で返る。
 * 延びるのは切断された UNC パスやオフラインの OneDrive を踏んだときだけで、
 * それは待っても回復しない。
 *
 * `--version` もここに含める。対応表の表には無いが、起動時に 1 回だけ走り、
 * **これが返らないとアプリが起動画面から進まない**。git 本体の応答性という
 * 意味では rev-parse と同じ性質（リポジトリを読まない）なので同じ値にする。
 */
export const REV_PARSE_TIMEOUT_MS = 10_000;

/**
 * #2 status。
 *
 * 所要時間は未追跡ディレクトリの走査が支配的。5 万ファイルでも数十秒で終わる想定に対し、
 * ウイルス対策のリアルタイムスキャンが重なった最悪値でも誤爆しない余裕として 300 秒を取る。
 */
export const STATUS_TIMEOUT_MS = 300_000;

/**
 * #3 for-each-ref / #4 remote。
 *
 * 所要時間は ref 数だけで決まり、数千 ref でも数秒。60 秒で十分な余裕がある。
 */
export const REF_LIST_TIMEOUT_MS = 60_000;

/**
 * #18 / #19 diff、#20 log、#21 show --name-status、#36 show。
 *
 * いずれも `--max-count` / `maxLines` で打ち切るので本来は短い。
 * 巨大なバイナリや極端に長い 1 ファイルを引いたときの上限として 120 秒。
 */
export const DIFF_TIMEOUT_MS = 120_000;

/**
 * 'exit' の後 'close' を待つ猶予。
 *
 * git 本体が終了した時点で stderr の最後の数行がまだパイプに残っていることがあるため、
 * すぐには解決しない。逆に、孫プロセス（credential helper、git-lfs filter-process）が
 * パイプを継承したまま生きていると 'close' は**永久に来ない**ので、待ち切らない。
 */
const STDIO_DRAIN_GRACE_MS = 200;

/**
 * 'exit' から読み切りを諦めるまでの上限。
 *
 * 猶予はデータが届くたびに測り直すので、終了後も出力が続いていれば待ち続けられる。
 * ただし喋り続ける孫プロセスが相手だと無限に延びてしまうため、全体の上限を置く。
 */
const STDIO_DRAIN_MAX_MS = 2_000;

interface RunHooks {
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderrLine?: (line: string) => void;
}

/**
 * spawn の ENOENT が「git が無い」のか「cwd が無い」のかを判定する。
 *
 * Windows ではどちらも `spawn git ENOENT` になり、エラーオブジェクトからは区別できない。
 * リポジトリのフォルダを移動・削除した状態で開いたときに
 * 「Git for Windows を導入してください」と出るのを防ぐため、cwd の存在を実際に確かめる。
 */
async function classifySpawnFailure(cmd: GitCommand, cause: NodeJS.ErrnoException): Promise<Error> {
  try {
    await access(cmd.cwd);
  } catch {
    return new GitWorkingDirectoryError(cmd.cwd, cause);
  }
  return new GitNotFoundError(cmd.gitPath, cause);
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

  // すべての git 実行がここを通るので、登録もここ 1 箇所で漏れなく行える。
  // 解除は必ず finally で（途中で throw しても登録が残らないようにする）。
  const unregister = registerGitProcess(child);

  let stderrText = '';
  let stderrCarry = '';
  let cancelled = false;
  let timedOut = false;

  const appendStderr = (text: string): void => {
    if (stderrText.length < STDERR_LIMIT) {
      stderrText += text.slice(0, STDERR_LIMIT - stderrText.length);
    }
  };

  /**
   * 'exit' 後の読み切り猶予を延長する。プロセス終了後もまだデータが流れているなら、
   * それは取りこぼしてはいけない出力なので、猶予を測り直す（下の run 本体で実体を入れる）。
   */
  let extendDrain: (() => void) | undefined;

  child.stdout?.on('data', (chunk: Buffer) => {
    extendDrain?.();
    hooks.onStdout?.(chunk);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    extendDrain?.();
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
    /*
     * 終了は 'exit' と 'close' の両方で受ける。
     *
     * 'close' は**すべての stdio が閉じたとき**にしか発火しない。git 本体が終了しても、
     * パイプを継承した孫（credential helper、git-lfs filter-process）が生きている限り
     * 閉じないので、'close' だけを待つと永久に await する。実際にこれが
     * 「不完全なリポジトリを開くとアプリ全体が無反応になる」の原因の一つだった。
     *
     * そこで 'exit' で終了コードを受け、stderr を読み切るための短い猶予を置いてから解決する。
     * 猶予内に 'close' が来れば（＝孫が残っていない通常の場合）即座に解決するので、
     * 既存の呼び出しの所要時間はほとんど変わらない。
     */
    const code = await new Promise<number>((resolve, reject) => {
      let settled = false;
      let drainTimer: NodeJS.Timeout | undefined;
      let exitedAt = 0;
      let exitedCode = -1;

      const finish = (done: () => void): void => {
        if (settled) return;
        settled = true;
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        done();
      };

      const scheduleDrain = (): void => {
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        drainTimer = setTimeout(() => finish(() => resolve(exitedCode)), STDIO_DRAIN_GRACE_MS);
      };

      child.once('error', (err: NodeJS.ErrnoException) => {
        /*
         * spawn に失敗すると 'error' の**直後に 'close'（code -4058）も飛ぶ**。
         * ENOENT の切り分けには fs のアクセス確認（非同期）が要るので、
         * 判定を待っている間に 'close' が resolve してしまわないよう、
         * ここで先に settled を立てて後続のイベントを締め出す。
         */
        if (settled) return;
        settled = true;
        if (drainTimer !== undefined) clearTimeout(drainTimer);

        if (err.code !== 'ENOENT') {
          reject(err);
          return;
        }
        void classifySpawnFailure(cmd, err).then(reject, reject);
      });

      child.once('exit', (exitCode) => {
        if (settled) return;
        // signal で殺された場合は exitCode が null になる（従来どおり -1 に寄せる）
        exitedCode = exitCode ?? -1;
        exitedAt = Date.now();
        scheduleDrain();
      });

      child.once('close', (exitCode) => finish(() => resolve(exitCode ?? -1)));

      // 終了後もデータが届いているうちは猶予を測り直す（大きい出力を切らないため）。
      // ただし際限なく延ばすと「孫が延々と喋る」ケースで元の木阿弥なので上限を設ける。
      extendDrain = (): void => {
        if (settled || exitedAt === 0) return;
        if (Date.now() - exitedAt > STDIO_DRAIN_MAX_MS) return;
        scheduleDrain();
      };
    });

    if (hooks.onStderrLine && stderrCarry.length > 0) hooks.onStderrLine(stderrCarry);
    if (timedOut) throw new GitTimeoutError(cmd.timeoutMs ?? 0);
    if (cancelled) throw new GitCancelledError();

    return { code, elapsedMs: Date.now() - startedAt, stderr: stderrText };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    unregister();
    /*
     * 孫が掴んだままのパイプを手放す。
     * 'close' を待たずに解決した場合、読み口を開けたままにすると
     * ハンドルが残り続け、孫の出力で進捗コールバックが呼ばれ続ける。
     * 'close' 経由で来た場合は既に閉じているので何も起きない。
     */
    child.stdout?.destroy();
    child.stderr?.destroy();
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
