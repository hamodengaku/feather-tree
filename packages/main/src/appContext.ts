import { join } from 'node:path';
import { app } from 'electron';
import {
  CommandLog,
  SessionManager,
  AppSettingsStore,
  checkGitVersion,
  locateGit,
  locateSsh,
  type AppSettings,
  type CommandStart,
  type GitLocation,
  type GitVersionCheck,
} from '@feathertree/core';
import { ensureDir, resolveTempDir, resolveUserDataDir, type AppPathOptions } from '@feathertree/base-electron';

/** userData / 一時ファイルの置き場。既定の %APPDATA% は使わない。 */
const APP_PATHS: AppPathOptions = { dataDirName: 'FeatherTree-data' };

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
  /** GIT_SSH_COMMAND に埋める ssh の絶対パス（決定 13 の追記）。未検出なら null。 */
  #sshPath: string | null = null;
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

  get sshPath(): string | null {
    return this.#sshPath;
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
      try {
        this.#gitVersion = await checkGitVersion(this.#git.gitPath, app.getPath('home'));
      } catch {
        // バージョン取得の失敗で起動を止めない
        this.#gitVersion = null;
      }
    }

    await this.#resolveSsh();
  }

  /**
   * `GIT_SSH_COMMAND` に埋める ssh を解決する（決定 13 の追記）。
   *
   * git の探索と同じく**起動時に 1 回だけ**。bare 名の `ssh` を渡さないための解決なので、
   * 見つからなければ null のままにして何も注入しない（git の既定に任せる）。
   * Git 同梱の ssh を候補にするため、git の解決より後に呼ぶ。
   */
  async #resolveSsh(): Promise<void> {
    this.#sshPath = await locateSsh({
      env: process.env,
      gitPath: this.#git?.gitPath ?? null,
    }).catch(() => null);
  }

  /**
   * 起動時に保存済みのタブを復元する。
   *
   * 各リポジトリはルート解決だけを行い、一覧を取得するのはアクティブな 1 つだけ
   * （docs/00-decisions.md やらないこと「起動時に全リポジトリの状態を先読みしない」）。
   */
  async restoreSessions(): Promise<void> {
    const roots = this.settings.current.openRepositories;
    if (roots.length === 0) return;
    const sessions = this.sessions();
    if (sessions === null) return;
    await sessions.restore(roots);
  }

  /** git が見つかっていなければ null。 */
  sessions(): SessionManager | null {
    if (this.#git === null) return null;
    if (this.#sessions === null) {
      this.#sessions = new SessionManager({
        gitPath: this.#git.gitPath,
        sshPath: this.#sshPath,
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
    this.#gitVersion =
      this.#git === null
        ? null
        : await checkGitVersion(this.#git.gitPath, app.getPath('home')).catch(() => null);
    // Git 同梱の ssh は git のパスから導くので、git を解決し直したらこちらも取り直す
    await this.#resolveSsh();
  }
}
