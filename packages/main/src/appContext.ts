import { join } from 'node:path';
import { app } from 'electron';
import {
  CommandLog,
  SessionManager,
  AppSettingsStore,
  checkGitVersion,
  locateGit,
  type AppSettings,
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

  /** 起動時に 1 回だけ。git の探索とバージョン確認はここでしか行わない。 */
  async initialize(): Promise<void> {
    await this.settings.load();

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
        tempDir: this.tempDir,
        commandLog: this.commandLog,
        settings: () => this.settings.current,
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
  }
}
