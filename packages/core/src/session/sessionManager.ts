import { randomUUID } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { RefreshCoordinator } from '@feathertree/base-core';
import { runClone, type CloneProgressListener, type CloneRunRequest, type CloneRunResult } from '../clone/cloneRunner.js';
import { RepositorySession, type SessionDeps } from './repositorySession.js';

export interface SessionInfo {
  readonly id: string;
  readonly root: string;
  readonly displayName: string;
}

/**
 * 復元 1 件あたりのルート解決（対応表 #1）を待つ上限（ms）。
 *
 * git 層にも #1 のタイムアウトがあるが、**それを信じ切らない**。
 * 復元はアプリが起動するかどうかを左右するので、上位でも必ず上限を持つ
 * （docs/01-architecture.md 5 章 2026-09-19 改定）。
 */
export const RESTORE_ROOT_TIMEOUT_MS = 5_000;

/**
 * 復元全体を待つ上限（ms）。
 *
 * 1 件あたりの上限だけだと、タブが 20 枚あれば最悪 100 秒待つことになる。
 * 使い切ったら残りは諦めて（失敗として記録して）起動を進める。
 */
export const RESTORE_TOTAL_BUDGET_MS = 8_000;

export type RestoreFailureReason = 'timeout' | 'broken' | 'skipped' | 'error';

/** 復元できなかったタブ。起動は続けるが、なぜ消えたかを残す。 */
export interface RestoreFailure {
  readonly root: string;
  readonly reason: RestoreFailureReason;
  readonly message: string;
}

/** 復元の上限。既定値をテストから縮めるためだけに開けてある。 */
export interface RestoreOptions {
  readonly rootTimeoutMs?: number;
  readonly totalBudgetMs?: number;
}

/** 復元が上限に達したことを、通常の git の失敗と区別するための印。 */
export class RestoreTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`リポジトリの確認が ${String(timeoutMs)}ms で返りませんでした。`);
    this.name = 'RestoreTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 選んだフォルダ自身が `.git` を持っているのに、git が別のルートを返したときの拒否。
 *
 * `.git/HEAD` が壊れていると git はそのフォルダをリポジトリと認めず、**親ディレクトリへ遡って
 * 別のリポジトリのルートを返す**（exit=0 で成功する。2026-09-19 実測）。
 * そのまま採用すると「壊れたフォルダを開いたのに、まったく別のリポジトリのタブが出る」か、
 * 既にそれが開かれていれば「既存タブに切り替わるだけで何も起きないように見える」。
 *
 * **選んだフォルダに `.git` が無い場合は対象外。** サブディレクトリを選ぶのは正当な操作で、
 * そのときルートを返すのは git の正しい挙動。
 */
export class BrokenRepositoryError extends Error {
  /** 利用者が選んだフォルダ。 */
  readonly selected: string;
  /** git が返した（＝親の）ルート。 */
  readonly resolvedRoot: string;

  constructor(selected: string, resolvedRoot: string) {
    super(
      'このフォルダの .git は読めません。壊れている可能性があります: ' +
        selected +
        '（git は別のリポジトリ「' +
        resolvedRoot +
        '」を返しました）',
    );
    this.name = 'BrokenRepositoryError';
    this.selected = selected;
    this.resolvedRoot = resolvedRoot;
  }
}

/** クローン（対応表 #37〜#41）の行き先と方法。検証は呼び出し側（main）が済ませている前提。 */
export type CloneTarget = CloneRunRequest;

/** クローンの結果。クローン自体ができていれば（succeeded / partial）セッションが立っている。 */
export interface CloneOutcome extends CloneRunResult {
  readonly session: RepositorySession | null;
}

/**
 * タブの集合を管理する。
 *
 * 重要な制約（docs/00-decisions.md 決定 12 / 「やらないこと」）:
 *  - タブ切替では git を 1 度も実行しない。保持済みスナップショットを表示するだけ
 *  - 非アクティブなタブは更新しない
 *  - 起動時に全リポジトリを先読みしない
 */
export class SessionManager {
  readonly #sessions = new Map<string, RepositorySession>();
  readonly #coordinator = new RefreshCoordinator();
  readonly #deps: SessionDeps;
  #activeId: string | null = null;
  #restoreFailures: RestoreFailure[] = [];

  constructor(deps: SessionDeps) {
    this.#deps = deps;
  }

  get activeId(): string | null {
    return this.#activeId;
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => ({
      id: s.id,
      root: s.root,
      displayName: displayNameOf(s.root),
    }));
  }

  get(id: string): RepositorySession | null {
    return this.#sessions.get(id) ?? null;
  }

  /** 既に同じリポジトリのタブがあれば再利用する（同じリポジトリを二重に開かない）。 */
  findByRoot(root: string): RepositorySession | null {
    for (const s of this.#sessions.values()) {
      if (samePath(s.root, root)) return s;
    }
    return null;
  }

  /**
   * タブを立てる 1 段目。対応表 #1（ルート解決）だけを実行する。
   *
   * 一覧を取らないので巨大リポジトリでもすぐ返る。呼び出し側は、返ってきた
   * セッションをタブとして見せてから load() を呼ぶ。**先にタブを立てないと、
   * 続く #2 〜 #4 がどのタブのものか UI 側で決まらない**（決定 26 / コマンドバー）。
   *
   * 既に同じリポジトリのタブがあれば、新しく作らずそれをアクティブにして返す。
   */
  async create(root: string, signal?: AbortSignal): Promise<RepositorySession> {
    const existing = this.findByRoot(root);
    if (existing !== null) {
      this.#activeId = existing.id;
      return existing;
    }

    const session = new RepositorySession(randomUUID(), root, this.#deps);
    await session.resolve(signal);
    // 壊れた .git のせいで親リポジトリを掴んでいないか確かめる（食い違ったときだけ I/O が増える）
    await assertNotBrokenRepository(root, session.root);
    this.#sessions.set(session.id, session);
    this.#activeId = session.id;
    return session;
  }

  /**
   * 2 段目。対応表 #2 → #3 → #4。時間がかかるのはこちら。
   * 読み込み済みのタブなら git を 1 度も実行しない。無い id は黙って無視する
   * （読み込み中にタブを閉じられた場合）。
   */
  async load(id: string, signal?: AbortSignal): Promise<void> {
    const session = this.#sessions.get(id);
    if (session === undefined) return;
    await session.ensureLoaded(signal);
  }

  /**
   * クローンしてタブを立てる（対応表 #37〜#41 → #1）。create() と同じく一覧は取らない。
   *
   * 手順の実行・コマンドログへの記録・ヒントの組み立ては cloneRunner が持つ。
   * git の失敗や中止は例外にせず結果で返す。**クローン自体ができていれば、途中で失敗・中止しても
   * タブを立てる**（決定 9。取得済みの数 GB を無駄にしない）。
   * #1 は中止の signal を渡さない。中止はクローンの手順に対するもので、立てるタブまで止めない。
   */
  async clone(req: CloneTarget, onProgress: CloneProgressListener, signal?: AbortSignal): Promise<CloneOutcome> {
    const target = join(req.parentDir, req.name);
    const existing = this.findByRoot(target);
    if (existing !== null) {
      // 同じ場所のタブがあるならクローンは必ず失敗する（空でないフォルダ）。git を走らせずにそのタブを返す
      this.#activeId = existing.id;
      return { result: 'succeeded', cancelled: false, target, stages: [], hints: [], followUps: [], log: '', session: existing };
    }

    const run = await runClone(
      req,
      { gitPath: this.#deps.gitPath, tempDir: this.#deps.tempDir, commandLog: this.#deps.commandLog },
      onProgress,
      signal,
    );
    if (run.result === 'failed') return { ...run, session: null };

    try {
      return { ...run, session: await this.create(run.target) };
    } catch {
      return {
        ...run,
        result: 'partial',
        session: null,
        hints: [
          ...run.hints,
          {
            id: 'open-failed',
            title: 'クローンしたフォルダを開けませんでした',
            body: '「リポジトリを開く」の「ローカルのリポジトリを開く…」から、次のフォルダを開いてください：' + run.target,
            commands: [],
          },
        ],
      };
    }
  }

  /** 1 段目と 2 段目をまとめて行う。UI からは使わない（テストと将来の CLI 用）。 */
  async open(root: string, signal?: AbortSignal): Promise<RepositorySession> {
    const session = await this.create(root, signal);
    await session.ensureLoaded(signal);
    return session;
  }

  /**
   * タブの並び替え。
   * order に無い既存タブは、渡された並びの後ろに元の順序で残す。
   * order に含まれるが存在しない id は無視する（閉じた後の競合に強くするため）。
   */
  reorder(order: readonly string[]): void {
    const next = new Map<string, RepositorySession>();
    for (const id of order) {
      const session = this.#sessions.get(id);
      if (session !== undefined) next.set(id, session);
    }
    for (const [id, session] of this.#sessions) {
      if (!next.has(id)) next.set(id, session);
    }
    this.#sessions.clear();
    for (const [id, session] of next) this.#sessions.set(id, session);
  }

  /** タブを閉じる。保留中のリフレッシュ要求も捨てる。 */
  close(id: string): void {
    this.#sessions.delete(id);
    this.#coordinator.discard(id);
    if (this.#activeId === id) {
      this.#activeId = this.#sessions.keys().next().value ?? null;
    }
  }

  /**
   * 起動時のタブ復元。
   *
   * 各リポジトリは #1（ルート解決）だけを実行し、一覧は取得しない。
   * アクティブにした 1 つだけを読み込む（決定 12 / やらないこと）。
   * 開けなかったリポジトリ（移動・削除済み）は飛ばす。
   *
   * **1 件ずつ独立して失敗できること**（docs/01-architecture.md 5 章 2026-09-19 改定）。
   * 従来は `try { await resolve() } catch { continue }` だったが、これは例外には効いても
   * 「返ってこない」には無力で、1 件が固まると起動そのものが止まっていた。
   * さらに先頭タブの `ensureLoaded()` が try の外にあり、例外が呼び出し元まで飛んでいた。
   *
   * 飛ばした理由は `restoreFailures` とコマンドログに残す。黙って消えたタブの理由が
   * どこにも残らないのが、この不具合で一番困った点だった。
   */
  async restore(
    roots: readonly string[],
    signal?: AbortSignal,
    options: RestoreOptions = {},
  ): Promise<string[]> {
    const rootTimeoutMs = options.rootTimeoutMs ?? RESTORE_ROOT_TIMEOUT_MS;
    const totalBudgetMs = options.totalBudgetMs ?? RESTORE_TOTAL_BUDGET_MS;
    const deadline = Date.now() + totalBudgetMs;

    this.#restoreFailures = [];
    const restored: string[] = [];

    for (const root of roots) {
      if (this.findByRoot(root) !== null) continue;

      const left = deadline - Date.now();
      if (left <= 0) {
        this.#noteRestoreFailure(
          root,
          'skipped',
          '起動時の復元が時間内に終わらなかったため、このタブは開けませんでした。',
        );
        continue;
      }

      const session = new RepositorySession(randomUUID(), root, this.#deps);
      const budget = Math.min(rootTimeoutMs, left);
      try {
        await this.#resolveWithin(session, root, budget, signal);
      } catch (err) {
        this.#noteRestoreFailure(root, reasonOf(err), messageOf(err));
        continue;
      }
      this.#sessions.set(session.id, session);
      restored.push(session.id);
    }

    const first = restored[0];
    if (first !== undefined && this.#activeId === null) {
      this.#activeId = first;
      const session = this.#sessions.get(first);
      /*
       * **必ず try で囲む。** ここが裸だと、先頭タブの #2 〜 #4 が失敗しただけで
       * 例外が AppContext を抜け、起動処理ごと落ちる（＝アプリが無言で消える）。
       * 読み込めなくてもタブは残し、利用者が切り替え直せばやり直せる状態にする。
       */
      if (session !== undefined) {
        /*
         * **読み込みも予算の内側に入れる。** ここを裸で待つと、#2 status の上限
         * （git 層で 300 秒）までスプラッシュの保険タイマー（10 秒）を追い越し、
         * 本体ウィンドウが生まれる前にアプリが終了しうる。
         * 読めなくてもタブは残るので、利用者が切り替え直せばやり直せる。
         */
        const left = deadline - Date.now();
        try {
          if (left <= 0) throw new RestoreTimeoutError(0);
          await this.#loadWithin(session, left, signal);
        } catch (err) {
          this.#noteRestoreFailure(session.root, reasonOf(err), messageOf(err));
        }
      }
    }
    return restored;
  }

  /** 直近の `restore()` で開けなかったタブ。起動後に理由を出すために持つ。 */
  get restoreFailures(): readonly RestoreFailure[] {
    return this.#restoreFailures;
  }

  /**
   * ルート解決に上限を与える。
   *
   * signal を渡したうえで**時間でも打ち切る**。二重に見えるが、
   * signal を見ない実装や、kill が効かない子プロセスがあっても
   * 「復元が返ってこない」状態にはしないため（起動が懸かっている）。
   */
  async #resolveWithin(
    session: RepositorySession,
    selected: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      await raceTimeout(session.resolve(controller.signal), timeoutMs, () => new RestoreTimeoutError(timeoutMs));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    await assertNotBrokenRepository(selected, session.root);
  }

  /**
   * 先頭タブの読み込み（#2 → #3 → #4）に上限を与える。
   *
   * #resolveWithin と同じ流儀。違いは、壊れたリポジトリの判定（ルートの食い違い）が
   * ルート解決側の話なのでここには無いことだけ。
   */
  async #loadWithin(session: RepositorySession, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      await raceTimeout(session.ensureLoaded(controller.signal), timeoutMs, () => new RestoreTimeoutError(timeoutMs));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #noteRestoreFailure(root: string, reason: RestoreFailureReason, message: string): void {
    this.#restoreFailures.push({ root, reason, message });
    /*
     * 実際に試したのはルート解決（対応表 #1）なので、その引数で残す。
     * 成功した #1 は記録しない規則（5 章）のままで、**失敗だけ**を残す。
     */
    this.#deps.commandLog.add({
      cwd: root,
      args: ['rev-parse', '--show-toplevel'],
      exitCode: -1,
      elapsedMs: 0,
      stderr: message,
    });
  }

  /**
   * タブ切替。
   * 既に読み込み済みなら git を 1 度も実行しない。
   * 復元直後の未読み込みタブに切り替えたときだけ、その 1 つを読み込む。
   */
  async activate(id: string, signal?: AbortSignal): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (session === undefined) return false;
    this.#activeId = id;
    await session.ensureLoaded(signal);
    return true;
  }

  /**
   * 手動更新 / ウィンドウ復帰時の入口。
   * 同じセッションへの要求は直列化され、連打しても git は積み上がらない。
   */
  async requestStatusRefresh(id: string, signal?: AbortSignal): Promise<void> {
    const session = this.#sessions.get(id);
    if (session === undefined) return;
    await this.#coordinator.request(id, () => session.refreshStatus(signal));
  }

  /** 「更新」ボタン: #2 → #3 の 2 プロセスまで許可される例外。 */
  async requestFullRefresh(id: string, signal?: AbortSignal): Promise<void> {
    const session = this.#sessions.get(id);
    if (session === undefined) return;
    await this.#coordinator.request(id, async () => {
      await session.refreshStatus(signal);
      await session.refreshBranches(signal);
    });
  }

  isBusy(id: string): boolean {
    return this.#coordinator.isBusy(id);
  }
}

export function displayNameOf(root: string): string {
  const normalized = root.split(String.fromCharCode(92)).join('/').replace(/\/+$/, '');
  const last = normalized.slice(normalized.lastIndexOf('/') + 1);
  return last.length > 0 ? last : normalized;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string =>
    p.split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** 上限を過ぎたら投げる。`promise` 自体は走り続けるので、呼び出し側が別途 abort すること。 */
function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, makeError: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(makeError()), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function reasonOf(err: unknown): RestoreFailureReason {
  if (err instanceof Error && err.name === 'RestoreTimeoutError') return 'timeout';
  if (err instanceof Error && err.name === 'BrokenRepositoryError') return 'broken';
  return 'error';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** realpath が引けなければ元の文字列で比べる（存在しない・権限が無い場合）。 */
async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * 「選んだフォルダ自身が `.git` を持つのに、git は別のルートを返した」を拒否する。
 *
 * 呼ぶのは**ルート解決が成功して、かつ食い違ったときだけ**。
 * 毎回打つ追加の検査にはしない（「基本 git 操作の前後にアプリ都合のチェックを挟まない」）。
 * 同期 I/O は使わない（CLAUDE.md の環境の癖 1）。
 */
async function assertNotBrokenRepository(selected: string, resolved: string): Promise<void> {
  if (samePath(selected, resolved)) return;

  /*
   * ジャンクション・シンボリックリンク・8.3 名の先を開くと、文字列では食い違うが
   * 実体は同じルートということがある。実体で一致するならそれは正当。
   */
  const [realSelected, realResolved] = await Promise.all([
    realpathOrSelf(selected),
    realpathOrSelf(resolved),
  ]);
  if (samePath(realSelected, realResolved)) return;

  /*
   * ここで初めて `.git` を見る。無ければ「リポジトリのサブディレクトリを選んだ」という
   * 正当な操作で、ルートを返すのは git の正しい挙動（退行させないこと）。
   * あるのに別のルートが返ったなら、その `.git` は git から読めない壊れた状態。
   */
  if (!(await pathExists(join(selected, '.git')))) return;

  throw new BrokenRepositoryError(selected, resolved);
}
