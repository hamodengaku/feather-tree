import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RefreshCoordinator } from '@feathertree/base-core';
import { runClone, type CloneProgressListener, type CloneRunRequest, type CloneRunResult } from '../clone/cloneRunner.js';
import { gitSshEnv } from '../env/sshCommand.js';
import { RepositorySession, type SessionDeps } from './repositorySession.js';

export interface SessionInfo {
  readonly id: string;
  readonly root: string;
  readonly displayName: string;
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
      {
        gitPath: this.#deps.gitPath,
        tempDir: this.#deps.tempDir,
        commandLog: this.#deps.commandLog,
        /*
         * SSH の URL をクローンするときに鍵が要る（決定 13 の追記）。
         * **クローンの時点ではまだリポジトリが無い**ので、鍵はリポジトリ別の設定から
         * 引けない。呼び出し側（クローンの入力）が選んだものをそのまま使う（決定 9）。
         */
        env: gitSshEnv(this.#deps.sshPath ?? null, req.sshKeyPath ?? null),
      },
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
   * 開けなかったリポジトリ（移動・削除済み）は黙って飛ばす。
   */
  async restore(roots: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const restored: string[] = [];
    for (const root of roots) {
      if (this.findByRoot(root) !== null) continue;
      const session = new RepositorySession(randomUUID(), root, this.#deps);
      try {
        await session.resolve(signal);
      } catch {
        continue;
      }
      this.#sessions.set(session.id, session);
      restored.push(session.id);
    }

    const first = restored[0];
    if (first !== undefined && this.#activeId === null) {
      this.#activeId = first;
      const session = this.#sessions.get(first);
      if (session !== undefined) await session.ensureLoaded(signal);
    }
    return restored;
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
