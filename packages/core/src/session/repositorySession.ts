import {
  GitCancelledError,
  GitCommandError,
  GitNotFoundError,
  getCommitFileDiff,
  getCommitFiles,
  getFileDiff,
  getHeadMessage,
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
import { mapGitOutput, type MappedError } from '../policy/errorMapping.js';
import { redactUrl } from '../policy/redactUrl.js';
import type { AppSettings } from '../settings/schema.js';
import { pageEntries, type StatusFilter, type StatusPage, type StatusSummary } from './statusView.js';
import { buildScriptIndex, type ScriptIndex } from './scriptIndex.js';
import { buildUnityView, type UnityView } from './unityView.js';
import { buildExcelComparison, excelToken, type ExcelComparison } from './excelView.js';
import { isExcelPath, listExcelFiles, type ExcelFileList } from './excelFiles.js';
import { resolveExcelConflict, type ExcelResolveRequest } from './excelConflict.js';
import { DEFAULT_LIMITS as DEFAULT_EXCEL_LIMITS } from '@feathertree/excel';

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

  /**
   * Unity モードのビュー（決定 32）。**セッションあたり 1 件だけ**持つ。
   *
   * LRU にすらしないのは、100MB のシーンを 2 側ぶん抱えると
   * それだけでヒープが数百 MB になるため（F-1）。別のファイルを選んだ時点で捨てる。
   */
  #unityView: UnityView | null = null;

  /**
   * guid -> スクリプト名 / Prefab 名（要件 11）。**セッションの間は持ち続ける。**
   *
   * ビューのキャッシュと違って中身は小さく（数千件の短い文字列）、
   * 作るのに数千ファイルを読むので、モードを行き来するたびに作り直したくない。
   */
  #scriptIndex: ScriptIndex | null = null;

  /**
   * Excel 差分の比較（決定 33）。**セッションあたり 1 件だけ**持つ（Unity と同じ理由）。
   *
   * `#excelGen` は組み立てを始めるたびに進める世代。組み終わったとき世代が進んでいれば、
   * 後から始まった組み立てがあるということなので、自分の結果をキャッシュに書かない
   * （遅れて終わった古い組み立てに、新しい結果を上書きさせない）。
   */
  #excel: ExcelComparison | null = null;
  #excelGen = 0;

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
      getStatus(this.context(signal), { noRenames: settings.noRenames }),
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
    this.#releaseExcelUnless(path);
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
    this.#releaseExcelUnless(path);
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

  /**
   * Unity モードのビュー（決定 32）。
   *
   * 鍵は**パス・ステージ側・status の世代**の 3 つ。`statusSeq` が進む（＝何かを
   * ステージした、更新した）と作り直すので、古い座標のまま当てることが起きない。
   */
  async getUnityView(path: string, staged: boolean, signal?: AbortSignal): Promise<UnityView> {
    this.#dropExcel();
    const cached = this.#unityView;
    if (
      cached !== null &&
      cached.path === path &&
      cached.staged === staged &&
      cached.statusSeq === this.#statusSeq
    ) {
      return cached;
    }
    // 先に捨てる。組み立てに失敗しても古いものが残らないようにする
    this.#unityView = null;
    const view = await buildUnityView(this, path, staged, signal, this.#resolveGuid);
    this.#unityView = view;
    return view;
  }

  /**
   * guid からスクリプト名 / Prefab 名を引く（要件 11）。
   *
   * 索引がまだ無ければ常に null を返し、表示は `MonoBehaviour (a1b2c3d4)` のままになる。
   * `this` に縛った矢印関数にしてあるのは、そのまま `buildUnityView` へ渡すため。
   */
  readonly #resolveGuid = (guid: string): string | null =>
    this.#scriptIndex?.names.get(guid) ?? null;

  /**
   * リポジトリ内の `*.meta` を走査して guid の索引を作る（要件 11）。**git は 0 プロセス。**
   *
   * **利用者が明示的にボタンを押したときだけ呼ぶ。** 巨大プロジェクトでは数千の
   * `.meta` を読むことになり、この環境はファイル I/O が極端に遅い（CLAUDE.md）。
   * 1 度作ったらセッションの間は使い回す。
   */
  async indexUnityScripts(signal?: AbortSignal): Promise<ScriptIndex> {
    /*
     * **件数ではなく「走査したか」で見る。** 対象の .meta が 1 つも無い
     * リポジトリ（スクリプトの無い Prefab だけの構成など）でも、
     * ボタンを押すたびに数千ファイルを読み直さないため。
     */
    const cached = this.#scriptIndex;
    if (cached !== null) return cached;
    this.#scriptIndex = await this.track(['scan-meta'], () =>
      buildScriptIndex(this.#root, signal),
    );
    // 既に組んだビューには古い名前が焼き付いているので、次の取得で作り直させる
    this.#unityView = null;
    return this.#scriptIndex;
  }

  /** Unity モードを離れたときに持ち物を手放す（100MB を掴み続けない）。 */
  releaseUnityView(): void {
    this.#unityView = null;
  }

  /* ---------------------------------------------------------------- Excel 差分（決定 33） */

  /** Excel ファイルの一覧。status のスナップショットを絞るだけで、git は 0 プロセス。 */
  listExcelFiles(): ExcelFileList {
    return listExcelFiles(this.#status);
  }

  /**
   * Excel の比較（HEAD ↔ 作業ツリー）。鍵は**パスと status の世代**。
   * 世代が進む（更新した・ウィンドウに戻った）と、HEAD 側（#49）から読み直す。
   */
  async getExcelComparison(path: string, signal?: AbortSignal): Promise<ExcelComparison> {
    const cached = this.#excel;
    if (cached !== null && cached.path === path && cached.statusSeq === this.#statusSeq) return cached;
    // 先に捨てる。組み立てに失敗しても古いものが残らないようにする
    this.#excel = null;
    this.#unityView = null;
    const gen = ++this.#excelGen;
    const built = await buildExcelComparison(this, path, gen, signal);
    if (this.#excelGen === gen) this.#excel = built;
    return built;
  }

  /** トークンが今のキャッシュを指していればそれを返す。作り直されていれば null（呼び出し側は diff-stale）。 */
  excelByToken(token: string): ExcelComparison | null {
    const cached = this.#excel;
    // status の世代が進んだら、作業ツリーも HEAD も変わっているかもしれない。古い比較の行番号で答えない
    if (cached === null || cached.statusSeq !== this.#statusSeq) return null;
    return excelToken(cached) === token ? cached : null;
  }

  /** Excel の比較を手放す（モードを離れたとき）。 */
  releaseExcel(): void {
    this.#dropExcel();
  }

  /**
   * Excel のコンフリクトを採用して作業ツリーへ書き戻す（決定 34）。index には触れない。
   *
   * **書いたら比較のキャッシュを捨てる。** index を動かさないので status の世代は進まず、
   * 世代を鍵にしたキャッシュのままだと、書く前の比較を返し続ける。
   */
  async resolveExcelConflict(view: ExcelComparison, request: ExcelResolveRequest, signal?: AbortSignal): Promise<void> {
    try {
      await resolveExcelConflict(this, view, request, DEFAULT_EXCEL_LIMITS.maxFileBytes, signal);
    } finally {
      // 失敗しても捨てる（書きかけ・照合で食い違った比較を残さない）
      this.#dropExcel();
    }
  }

  /** 差分モードで Excel 以外のファイルを見たら、抱えているブックを手放す。 */
  #releaseExcelUnless(path: string): void {
    if (!isExcelPath(path)) this.#dropExcel();
  }

  /**
   * 比較を手放す。**世代も進める**——組み立て中の getExcelComparison が後から終わっても、
   * 手放した後のキャッシュに書き戻さないため（数百 MB のブックが見えないまま残る）。
   */
  #dropExcel(): void {
    this.#excel = null;
    this.#excelGen += 1;
  }

  /* ---------------------------------------------------------------- コミットログ */

  /** 対応表 #20。範囲は設定 `logCurrentBranchOnly`（オフなら `--all`、オンなら HEAD）。 */
  async getLogPage(skip: number, signal?: AbortSignal): Promise<CommitSummary[]> {
    const settings = this.#deps.settings();
    return this.track(['log'], () =>
      getLog(this.context(signal), {
        maxCount: settings.logPageSize,
        skip,
        scope: settings.logCurrentBranchOnly ? 'head' : 'all',
      }),
    );
  }

  /** 対応表 #49: HEAD のメッセージ全文（amend の初期値）。コミットが無ければ null。 */
  async getHeadMessage(signal?: AbortSignal): Promise<string | null> {
    return this.track(['log', '-1'], () => getHeadMessage(this.context(signal)));
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
    // stdout も渡す（merge / pull の競合は stdout にしか出ない）
    return mapGitOutput(err.stderr, err.stdout, err.exitCode);
  }
  if (err instanceof Error) {
    return { kind: 'internal', message: '内部エラーが発生しました。', detail: err.message };
  }
  return { kind: 'internal', message: '内部エラーが発生しました。' };
}
