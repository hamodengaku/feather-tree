import { join } from 'node:path';
import { app } from 'electron';
import {
  CommandLog,
  SessionManager,
  AppSettingsStore,
  checkGitVersion,
  locateGit,
  type AppSettings,
  type CommandStart,
  type GitLocation,
  type GitVersionCheck,
} from '@feathertree/core';
import { ensureDir, resolveTempDir, resolveUserDataDir, type AppPathOptions } from '@feathertree/base-electron';

/** userData / 一時ファイルの置き場。既定の %APPDATA% は使わない。 */
const APP_PATHS: AppPathOptions = { dataDirName: 'FeatherTree-data' };

/**
 * `git --version`（対応表 #32）を待つ上限（ms）。
 *
 * ここは起動処理の直列の途中にあるので、返らなければウィンドウの読み込みも始まらない。
 * バージョンは警告表示にしか使わないので、取れなければ null のまま先へ進む
 * （docs/01-architecture.md 11 章 2026-09-19 追加分）。
 */
const GIT_VERSION_TIMEOUT_MS = 5_000;

/** 上限を過ぎたら abort し、待つのをやめる。 */
async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let settled: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((resolve) => {
        // signal を見ない実装でも必ず返るようにする最後の網
        settled = setTimeout(() => resolve(fallback), timeoutMs + 500);
        settled.unref?.();
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
    if (settled !== undefined) clearTimeout(settled);
  }
}

/**
 * main プロセスが持つ唯一の可変状態。
 * core 層の組み立てはここだけで行い、ハンドラは組み立て済みのものを使う。
 */
export class AppContext {
  readonly settings: AppSettingsStore;
  readonly commandLog = new CommandLog();
  readonly userDataDir: string;
  readonly tempDir: string;

  /**
   * git の実行開始／終了の通知先（決定 26）。
   *
   * 差し込み口を可変フィールドにしてあるのは、SessionManager が遅延生成であるため。
   * index.ts が BrowserWindow を作った後にここへ入れれば、以降に立つセッションに届く。
   */
  onCommandStart: ((event: CommandStart) => void) | null = null;
  onCommandEnd: ((opId: string) => void) | null = null;

  #sessions: SessionManager | null = null;
  #git: GitLocation | null = null;
  #gitVersion: GitVersionCheck | null = null;

  constructor() {
    this.userDataDir = ensureDir(resolveUserDataDir(APP_PATHS));
    this.tempDir = ensureDir(resolveTempDir(APP_PATHS));
    // 設定の保存先は main が決める（core は electron を知らない）
    this.settings = new AppSettingsStore(join(this.userDataDir, 'settings.json'));
  }

  get git(): GitLocation | null {
    return this.#git;
  }

  get gitVersion(): GitVersionCheck | null {
    return this.#gitVersion;
  }

  currentSettings(): AppSettings {
    return this.settings.current;
  }

  /**
   * settings.json を読むだけ。**initialize() より先に呼ぶ。**
   *
   * 分けてあるのはスプラッシュ（決定 28）のため。スプラッシュの背景色と文字色は
   * テーマに合わせたいので設定が必要だが、git の探索（reg を spawn することもある）や
   * `--version` を待つ必要は無い。JSON 1 本を読んだ時点で絵を出せる。
   */
  async loadSettings(): Promise<void> {
    await this.settings.load();
  }

  /**
   * 起動時に 1 回だけ。git の探索とバージョン確認はここでしか行わない。
   * 設定は `loadSettings()` が済ませてある前提。
   */
  async initialize(): Promise<void> {
    const configured = this.settings.current.gitPath;
    this.#git = await locateGit({
      env: process.env,
      ...(configured === null ? {} : { configuredPath: configured }),
    });

    if (this.#git !== null) {
      const gitPath = this.#git.gitPath;
      // バージョン取得の失敗でも、**返ってこないことでも**起動を止めない
      this.#gitVersion = await withDeadline<GitVersionCheck | null>(
        (signal) => checkGitVersion(gitPath, app.getPath('home'), signal),
        GIT_VERSION_TIMEOUT_MS,
        null,
      );
    }
  }

  /**
   * 起動時に保存済みのタブを復元する。
   *
   * 各リポジトリはルート解決だけを行い、一覧を取得するのはアクティブな 1 つだけ
   * （docs/00-decisions.md やらないこと「起動時に全リポジトリの状態を先読みしない」）。
   *
   * **ここは投げない。** 1 件ずつの失敗もタイムアウトも SessionManager が飲み込み、
   * 理由は `sessions.restoreFailures` とコマンドログに残る。
   * 投げると index.ts の起動処理ごと落ちる（＝アプリが無言で消える）。
   */
  async restoreSessions(): Promise<void> {
    const roots = this.settings.current.openRepositories;
    if (roots.length === 0) return;
    const sessions = this.sessions();
    if (sessions === null) return;
    try {
      await sessions.restore(roots);
    } catch {
      // 復元の失敗で起動を止めない（restore 自体が投げない作りだが、二重に塞いでおく）
    }
  }

  /** git が見つかっていなければ null。 */
  sessions(): SessionManager | null {
    if (this.#git === null) return null;
    if (this.#sessions === null) {
      this.#sessions = new SessionManager({
        gitPath: this.#git.gitPath,
        tempDir: this.tempDir,
        commandLog: this.commandLog,
        settings: () => this.settings.current,
        // 生成時点では通知先が未設定でも、呼ばれる時には入っている（毎回読み直す）
        onCommandStart: (event) => this.onCommandStart?.(event),
        onCommandEnd: (opId) => this.onCommandEnd?.(opId),
      });
    }
    return this.#sessions;
  }

  /** git.exe のパス設定が変わったらセッション管理を作り直す。 */
  async reloadGit(): Promise<void> {
    this.#sessions = null;
    const configured = this.settings.current.gitPath;
    this.#git = await locateGit({
      env: process.env,
      ...(configured === null ? {} : { configuredPath: configured }),
    });
    const gitPath = this.#git?.gitPath ?? null;
    this.#gitVersion =
      gitPath === null
        ? null
        : await withDeadline<GitVersionCheck | null>(
            (signal) => checkGitVersion(gitPath, app.getPath('home'), signal),
            GIT_VERSION_TIMEOUT_MS,
            null,
          );
  }
}
