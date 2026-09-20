import {
  GitCancelledError,
  GitCommandError,
  GitNotFoundError,
  getCommitFileDiff,
  getCommitFiles,
  getFileDiff,
  getLog,
  getStashFileDiff,
  getStashFiles,
  getStatus,
  getUntrackedFileDiff,
  listBranches,
  listRemotes,
  listStashes,
  readConflictFile,
  readConflictText,
  readUserIdentity,
  resolveRepository,
  setLocalUserIdentity,
  writeConflictText,
  type BranchRef,
  type CommitFileChange,
  type CommitSummary,
  type ConflictFile,
  type ConflictParse,
  type FileDiff,
  type GitContext,
  type StashEntry,
  type StatusSnapshot,
  type TextLine,
  type UserIdentity,
} from '@feathertree/git';
import type { CommandLog } from '@feathertree/base-core';
import { gitSshEnv, sshKeyFor } from '../env/sshCommand.js';
import { mapGitStderr, type MappedError } from '../policy/errorMapping.js';
import { redactUrl } from '../policy/redactUrl.js';
import type { AppSettings } from '../settings/schema.js';
import { pageEntries, type StatusFilter, type StatusPage, type StatusSummary } from './statusView.js';

/** パッチ適用のために diff を取り直すときの行数上限（設定の上限値と同じ）。 */
const PATCH_MAX_LINES = 200000;

/** コマンドログとコマンドバーに出す短縮ハッシュ。40 文字を並べても読めない。 */
function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

/**
 * git の実行が「今まさに走っている」ことの通知。
 * コマンドログ（CommandLogEntry）は終わったものだけを持つので、それでは実行中が分からない。
 */
export interface CommandStart {
  readonly sessionId: string;
  /** 開始と終了を突き合わせるための識別子。セッション内で一意。 */
  readonly opId: string;
  /** コマンドログと同じ短いラベル（['fetch', 'origin'] など）。 */
  readonly args: readonly string[];
}

export interface SessionDeps {
  readonly gitPath: string;
  /**
   * `GIT_SSH_COMMAND` に埋める ssh の絶対パス（決定 13 の追記）。
   * 見つかっていなければ null で、その場合は鍵を登録していても何も注入しない。
   * 解決は locateSsh が起動時に 1 回だけ行う（bare 名を渡さないため。診断 1-A）。
   */
  readonly sshPath?: string | null;
  readonly tempDir: string;
  readonly commandLog: CommandLog;
  readonly settings: () => AppSettings;
  /**
   * git の実行開始と終了。コマンドバーに出すためのもの（決定 26）。
   * 省略可能にしてあるのは、通知先を持たない使い方（テスト・将来の CLI）を壊さないため。
   */
  readonly onCommandStart?: (event: CommandStart) => void;
  readonly onCommandEnd?: (opId: string) => void;
}

export type SessionChange = 'status' | 'branches' | 'remotes' | 'log';

/**
 * タブ 1 つ = セッション 1 つ。
 *
 * status のスナップショットの正本はここに置く。renderer には可視範囲だけを渡す
 * （docs/01-architecture.md 6 章）。セッション間で状態を共有しない。
 */
export class RepositorySession {
  readonly id: string;
  readonly #deps: SessionDeps;
  #root: string;
  #gitDir = '';

  #status: StatusSnapshot | null = null;
  /** スナップショットの世代番号。renderer が古い応答を捨てるために使う。 */
  #statusSeq = 0;
  #branches: readonly BranchRef[] = [];
  #remotes: readonly string[] = [];
  /** track() が発行する opId の連番。 */
  #opSeq = 0;

  readonly #listeners = new Set<(change: SessionChange) => void>();

  constructor(id: string, root: string, deps: SessionDeps) {
    this.id = id;
    this.#root = root;
    this.#deps = deps;
  }

  get root(): string {
    return this.#root;
  }

  get gitDir(): string {
    return this.#gitDir;
  }

  get statusSeq(): number {
    return this.#statusSeq;
  }

  get branches(): readonly BranchRef[] {
    return this.#branches;
  }

  get remotes(): readonly string[] {
    return this.#remotes;
  }

  onChange(listener: (change: SessionChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 一覧を取得済みか。復元したタブは未取得の状態で始まる。 */
  get loaded(): boolean {
    return this.#status !== null;
  }

  /**
   * 対応表 #1 のみ。リポジトリの実在確認とルート解決だけを行う。
   *
   * 起動時のタブ復元ではこれだけを実行する。
   * 「起動時に全リポジトリの状態を先読みしない」を守るため
   * （docs/00-decisions.md やらないこと）。
   */
  async resolve(signal?: AbortSignal): Promise<void> {
    const location = await resolveRepository(this.context(signal));
    this.#root = location.root;
    this.#gitDir = location.gitDir;
  }

  /**
   * 対応表の許可された例外: タブを開いた瞬間のみ #1 から #4 を続けて実行する。
   */
  async open(signal?: AbortSignal): Promise<void> {
    await this.resolve(signal);
    await this.ensureLoaded(signal);
  }

  /** 未取得なら一覧を取得する。取得済みなら git を 1 度も実行しない。 */
  async ensureLoaded(signal?: AbortSignal): Promise<void> {
    if (this.loaded) return;
    await this.refreshStatus(signal);
    await this.refreshBranches(signal);
    await this.refreshRemotes(signal);
  }

  /** 対応表 #2。ウィンドウ復帰時と手動更新のみが入口。 */
  async refreshStatus(signal?: AbortSignal): Promise<void> {
    const settings = this.#deps.settings();
    this.#status = await this.track(['status'], () =>
      getStatus(this.context(signal), {
        noRenames: settings.noRenames,
        untrackedFiles: settings.untrackedFiles,
      }),
    );
    this.#statusSeq += 1;
    this.#emit('status');
  }

  /** 対応表 #3。 */
  async refreshBranches(signal?: AbortSignal): Promise<void> {
    this.#branches = await this.track(['for-each-ref'], () => listBranches(this.context(signal)));
    this.#emit('branches');
  }

  /** 対応表 #4。 */
  async refreshRemotes(signal?: AbortSignal): Promise<void> {
    this.#remotes = await this.track(['remote'], () => listRemotes(this.context(signal)));
    this.#emit('remotes');
  }

  /** renderer へ返すページ。IPC にパス配列を流さないための境界。 */
  getStatusPage(offset: number, limit: number, filter?: StatusFilter): StatusPage {
    if (this.#status === null) return { offset: 0, entries: [], filteredTotal: 0 };
    return pageEntries(this.#status, offset, limit, filter ?? {});
  }

  getStatusSummary(): StatusSummary {
    if (this.#status === null) {
      return {
        counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0, total: 0 },
        hasSnapshot: false,
      };
    }
    return { counts: this.#status.counts, hasSnapshot: true };
  }

  /** 内部利用（操作対象の解決など）。スナップショットそのものは renderer へ渡さない。 */
  get snapshot(): StatusSnapshot | null {
    return this.#status;
  }

  /** 対応表 #18 / #19。選択された 1 件に対してのみ実行する。 */
  async getDiff(path: string, staged: boolean, signal?: AbortSignal): Promise<FileDiff | null> {
    const settings = this.#deps.settings();
    const options = { contextLines: settings.diffContextLines, maxLines: settings.diffMaxLines };

    const entry = this.#status?.entries.find((e) => e.path === path);
    if (entry?.kind === 'untracked' && !staged) {
      return this.track(['read-untracked', path], () =>
        getUntrackedFileDiff(this.context(signal), path, options),
      );
    }

    return this.track(['diff', path], () => getFileDiff(this.context(signal), path, staged, options));
  }

  /**
   * 未マージファイルのマーカー表示（対応表の対象外。**git は 0 プロセス**）。
   *
   * `git diff` は未マージのファイルに結合 diff を出すだけでマーカーの中身を返さないため、
   * 作業ツリーのファイルを直接読む。文脈行数・行数上限は diff の表示と同じ設定に従う。
   * ファイルが作業ツリーに無ければ（削除との衝突）null。
   */
  async getConflict(path: string, signal?: AbortSignal): Promise<ConflictFile | null> {
    const settings = this.#deps.settings();
    return this.track(['read-conflict', path], () =>
      readConflictFile(this.context(signal), path, {
        contextLines: settings.diffContextLines,
        maxLines: settings.diffMaxLines,
      }),
    );
  }

  /**
   * 採用の直前に読み直す解析結果（表示用の組み替えをしない生の形）。
   *
   * diff の `getDiffForPatch` と同じ理由でここだけ別口にしてある。表示は行数上限で
   * 切り詰められうるが、**書き戻す対象は欠けの無い全行**でなければならない。
   */
  async readConflict(
    path: string,
    signal?: AbortSignal,
  ): Promise<(ConflictParse & { readonly binary: boolean }) | null> {
    return this.track(['read-conflict', path], () => readConflictText(this.context(signal), path));
  }

  /** 採用の結果を作業ツリーへ書き戻す（インデックスには触れない）。 */
  async writeConflict(path: string, lines: readonly TextLine[], signal?: AbortSignal): Promise<void> {
    return this.track(['write-conflict', path], () =>
      writeConflictText(this.context(signal), path, lines),
    );
  }

  /** パッチ生成に使う文脈行数。diff の取得と apply のフラグを揃えるために公開する。 */
  get diffContextLines(): number {
    return this.#deps.settings().diffContextLines;
  }

  /**
   * パッチ適用の直前に取り直す diff（対応表 #33 / #34）。
   *
   * 表示用の diffMaxLines では足りない場合がある。パッチは欠けの無いデータからしか
   * 作れないので、ここだけ上限を大きく取る。文脈行数は表示と揃える
   * （揃えないと renderer が送ってきた hunk の添字と対応が取れない）。
   */
  async getDiffForPatch(path: string, staged: boolean, signal?: AbortSignal): Promise<FileDiff | null> {
    const settings = this.#deps.settings();
    const options = { contextLines: settings.diffContextLines, maxLines: PATCH_MAX_LINES };

    // 未追跡は表示と同じ合成 diff を返す。preamble が空なので
    // 呼び出し側の canBuildPatch が「パッチ生成不可」と正しく答えられる
    const entry = this.#status?.entries.find((e) => e.path === path);
    if (entry?.kind === 'untracked' && !staged) {
      return this.track(['read-untracked', path], () =>
        getUntrackedFileDiff(this.context(signal), path, options),
      );
    }

    return this.track(['diff', path], () => getFileDiff(this.context(signal), path, staged, options));
  }

  /** 対応表 #20。範囲は git 層で `--all` 固定。 */
  async getLogPage(skip: number, signal?: AbortSignal): Promise<CommitSummary[]> {
    const settings = this.#deps.settings();
    return this.track(['log'], () =>
      getLog(this.context(signal), { maxCount: settings.logPageSize, skip }),
    );
  }

  /** 対応表 #21: コミットの変更ファイル一覧。マージコミットでは空になる（git の既定）。 */
  async getCommitFiles(oid: string, signal?: AbortSignal): Promise<CommitFileChange[]> {
    return this.track(['show', shortOid(oid)], () => getCommitFiles(this.context(signal), oid));
  }

  /**
   * 対応表 #36: コミット内の 1 ファイルの diff。
   * 文脈行数と行数上限は作業ツリーの diff（#18 / #19）と同じ設定に従う。
   */
  async getCommitDiff(oid: string, path: string, signal?: AbortSignal): Promise<FileDiff | null> {
    const settings = this.#deps.settings();
    return this.track(['show', shortOid(oid), path], () =>
      getCommitFileDiff(this.context(signal), oid, path, {
        contextLines: settings.diffContextLines,
        maxLines: settings.diffMaxLines,
      }),
    );
  }

  /* ---------------------------------------------------------------- stash（決定 31） */

  /**
   * 対応表 #28: stash の一覧。
   *
   * **スナップショットとして持たない**（branches / remotes と違う扱いにしてある）。
   * 持つとリポジトリを開くとき（#1 〜 #4）に 1 プロセス増えるが、Stash 解放モードを
   * 開かない利用者にはその 1 本が丸ごと無駄になる。履歴（#20）と同じく、
   * **見えているモードに入った瞬間に初めて取る**。
   */
  async listStashes(signal?: AbortSignal): Promise<StashEntry[]> {
    return this.track(['stash', 'list'], () => listStashes(this.context(signal)));
  }

  /**
   * 対応表 #45: stash の変更ファイル一覧。
   *
   * 参照は**生の oid**。`stash@{n}` の n は drop / pop のたびにずれるので、
   * 一覧が古いまま読むと別の stash を見せてしまう（docs/02-git-command-map.md の
   * 「参照の渡し方」）。
   */
  async getStashFiles(oid: string, signal?: AbortSignal): Promise<CommitFileChange[]> {
    return this.track(['stash', 'show', shortOid(oid)], () =>
      getStashFiles(this.context(signal), oid),
    );
  }

  /**
   * 対応表 #46: stash 内の 1 ファイルの diff。
   * 文脈行数と行数上限は作業ツリーの diff（#18 / #19）と同じ設定に従う。
   *
   * `fromUntracked` は外部で `-u` 付きに作られた stash 用の打ち直し（#46 の注記）。
   */
  async getStashDiff(
    oid: string,
    path: string,
    fromUntracked: boolean,
    signal?: AbortSignal,
  ): Promise<FileDiff | null> {
    const settings = this.#deps.settings();
    return this.track(['diff', shortOid(oid), path], () =>
      getStashFileDiff(this.context(signal), oid, path, {
        contextLines: settings.diffContextLines,
        maxLines: settings.diffMaxLines,
        fromUntracked,
      }),
    );
  }

  /**
   * 対応表 #42（→ 必要なら #43）: コミット情報を読む。
   *
   * 読むだけでリポジトリの状態は変わらないので、スナップショット（status / branches）にも
   * 世代番号にも触れない。SessionOperations ではなくこちら側に置いているのはそのため。
   */
  async getCommitIdentity(signal?: AbortSignal): Promise<UserIdentity> {
    return this.track(['config', 'user.name'], () => readUserIdentity(this.context(signal)));
  }

  /**
   * 対応表 #44: コミット情報を**このリポジトリの .git/config** に書く。
   *
   * 変えるキーだけを渡す（null は「変えない」）。`git config` は 1 回に 1 キーしか
   * 設定できないので、両方変えれば git は 2 回動く（例外表に記載）。
   * 値の検証は呼び出し側（main）が済ませている前提。
   * 保存後に読み直さない——書いた値がそのままローカル値になるのは確実なので、
   * プロセスを増やす意味が無い。
   */
  async setLocalCommitIdentity(
    patch: { readonly name?: string; readonly email?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    for (const key of ['name', 'email'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      await this.track(['config', 'user.' + key], () =>
        setLocalUserIdentity(this.context(signal), key, value),
      );
    }
  }

  /**
   * 書き込み操作（SessionOperations）からも使うので公開する。
   *
   * env は毎回 settings から作り直す。文脈はコマンドごとに組み立てられるので、
   * **SSH 鍵の設定を変えたら次の git から効く**（アプリの再起動もセッションの張り直しも要らない）。
   * 鍵は**このリポジトリに登録されたもの**だけを見る（決定 13 の 2026-09-19 改定 2）。
   */
  context(signal?: AbortSignal): GitContext {
    const env = gitSshEnv(
      this.#deps.sshPath ?? null,
      sshKeyFor(this.#deps.settings(), this.#root),
    );
    return {
      gitPath: this.#deps.gitPath,
      cwd: this.#root,
      tempDir: this.#deps.tempDir,
      ...(Object.keys(env).length === 0 ? {} : { env }),
      ...(signal === undefined ? {} : { signal }),
    };
  }

  /**
   * 実行を必ずコマンドログへ記録する。透明性の担保（決定 16）。
   * 読み取りだけでなく**書き込み操作もここを通す**（SessionOperations から使う）。
   *
   * **全 git 実行が通る唯一の関門**なので、実行中の通知もここだけで行う。
   * 操作を足すたびに通知を書き足す必要は無い。
   * 唯一の例外はルート解決（対応表 #1）で、セッションが立つ前なので通らない。
   */
  async track<T>(args: readonly string[], run: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    const opId = this.id + ':' + String(++this.#opSeq);
    this.#deps.onCommandStart?.({ sessionId: this.id, opId, args });
    try {
      const result = await run();
      this.#deps.commandLog.add({
        cwd: this.#root,
        args,
        exitCode: 0,
        elapsedMs: Date.now() - startedAt,
        // 実行ログをタブごとに見せるため、どのタブの実行かを残す
        scope: this.id,
      });
      return result;
    } catch (err) {
      const mapped = toMappedError(err);
      /*
       * fetch/pull/push はここを通る唯一の関門（track() のコメント参照）。git の stderr には
       * リモート URL が現れることがあり、利用者が資格情報埋め込み URL
       * （`https://user:TOKEN@host/...`）を remote に設定していれば平文で残る（診断 §11 残存指摘）。
       * クローン（cloneRunner.ts）と同じ理由でコマンドログに渡す前に redactUrl を通す。
       * redactUrl は冪等（既に *** に置換済みの文字列を渡しても変化しない）なので、
       * クローンの生ログ等、別経路で既に一度適用されていても二重適用で壊れない。
       */
      this.#deps.commandLog.add({
        cwd: this.#root,
        args,
        exitCode: mapped.exitCode ?? -1,
        elapsedMs: Date.now() - startedAt,
        ...(mapped.detail === undefined ? {} : { stderr: redactUrl(mapped.detail) }),
        scope: this.id,
      });
      throw err;
    } finally {
      this.#deps.onCommandEnd?.(opId);
    }
  }

  #emit(change: SessionChange): void {
    for (const listener of this.#listeners) listener(change);
  }
}

/** git 層の例外を UI 向けの構造へ写す。core が Result への変換点を持つ。 */
export function toMappedError(err: unknown): MappedError {
  if (err instanceof GitNotFoundError) {
    return {
      kind: 'git-not-found',
      message: 'git を実行できませんでした。Git for Windows を導入してください。',
      detail: err.gitPath,
    };
  }
  if (err instanceof GitCancelledError) {
    return { kind: 'cancelled', message: '操作を中断しました。' };
  }
  if (err instanceof GitCommandError) {
    return mapGitStderr(err.stderr, err.exitCode);
  }
  if (err instanceof Error) {
    return { kind: 'internal', message: '内部エラーが発生しました。', detail: err.message };
  }
  return { kind: 'internal', message: '内部エラーが発生しました。' };
}
