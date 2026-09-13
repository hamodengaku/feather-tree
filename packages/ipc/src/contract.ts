/**
 * main と renderer の間の唯一の共有物。型と定数だけを置き、実装は一切書かない。
 *
 * docs/01-architecture.md 6 章の原則:
 *   1. すべて invoke / handle のリクエスト応答。投げっぱなしは進捗通知だけ
 *   2. 例外を throw せず Result で返す
 *   3. 一覧の応答には世代番号 seq を載せ、古い応答を捨てられるようにする
 *   4. パスの束を IPC で往復させない（操作は「範囲指定」で送る）
 *
 * DTO はここで独立に定義する。git 層の型を import しないことで、
 * 内部実装の変更がワイヤ形式に漏れないようにする（renderer は ipc だけを見る）。
 */

import type {
  BaseErrorDto,
  BaseErrorKind,
  Result as BaseResult,
} from '@feathertree/base-contract';

export const CHANNELS = {
  appGetInfo: 'app:getInfo',
  appGetEnvironment: 'app:getEnvironment',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  sessionPickAndCreate: 'session:pickAndCreate',
  sessionLoad: 'session:load',
  sessionOpen: 'session:open',
  clonePickDirectory: 'clone:pickDirectory',
  sessionCloneAndCreate: 'session:cloneAndCreate',
  sessionList: 'session:list',
  sessionActivate: 'session:activate',
  sessionClose: 'session:close',
  sessionRefresh: 'session:refresh',
  sessionReorder: 'session:reorder',

  statusGetSummary: 'status:getSummary',
  statusGetPage: 'status:getPage',

  stage: 'op:stage',
  unstage: 'op:unstage',
  stageHunks: 'op:stageHunks',
  unstageHunks: 'op:unstageHunks',
  discard: 'op:discard',
  deleteUntracked: 'op:deleteUntracked',
  commit: 'op:commit',

  diffGet: 'diff:get',
  logGetPage: 'log:getPage',
  commitGetFiles: 'commit:getFiles',
  commitGetDiff: 'commit:getDiff',
  branchList: 'branch:list',
  branchSwitch: 'branch:switch',
  branchCreate: 'branch:create',
  branchMerge: 'branch:merge',

  remoteList: 'remote:list',
  remoteFetch: 'remote:fetch',
  remotePull: 'remote:pull',
  remotePush: 'remote:push',

  shellOpenPath: 'shell:openPath',
  shellShowInFolder: 'shell:showInFolder',
  shellOpenTerminal: 'shell:openTerminal',

  commandLogRecent: 'diag:commandLog',

  // main -> renderer の通知
  eventSessionChanged: 'event:sessionChanged',
  eventProgress: 'event:progress',
  eventFocusRefreshPrompt: 'event:focusRefreshPrompt',
  eventCommandStart: 'event:commandStart',
  eventCommandEnd: 'event:commandEnd',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

// ---------------------------------------------------------------- 結果とエラー

/**
 * FeatherTree 固有のエラー種別。
 * 汎用の種別（cancelled / invalid-path / needs-confirmation / internal 等）は
 * 土台の BaseErrorKind を合併して使う。
 */
export type FtErrorKind =
  | BaseErrorKind
  | 'git-not-found'
  | 'git-failed'
  | 'not-a-repository'
  | 'no-session'
  | 'diff-stale'
  | 'too-many-paths';

export type FtErrorDto = BaseErrorDto<FtErrorKind>;

export type Result<T> = BaseResult<T, FtErrorDto>;


// ---------------------------------------------------------------- アプリと環境

export interface AppInfoDto {
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly chromeVersion: string;
  readonly nodeVersion: string;
  readonly userDataDir: string;
  readonly isPackaged: boolean;
}

export interface EnvironmentDto {
  /** git が見つからなければ null。導入案内を出す。 */
  readonly gitPath: string | null;
  readonly gitSource: 'configured' | 'path' | 'registry' | null;
  readonly gitVersion: string | null;
  /** 古い git などの警告。無ければ null。 */
  readonly warning: string | null;
}

export interface SettingsDto {
  readonly gitPath: string | null;
  readonly theme: 'classic-dark' | 'classic-light' | 'phoenix-dark' | 'phoenix-light';
  readonly noRenames: boolean;
  readonly untrackedFiles: 'normal' | 'all';
  readonly diffContextLines: number;
  readonly diffMaxLines: number;
  readonly logPageSize: number;
  /** ペイン領域のモード（決定 27）。'diff' = 左右 3 分割、'log' = 上下 2 分割の履歴。 */
  readonly viewMode: 'diff' | 'log';
  readonly logDetailHeight: number;
  readonly commitFileListWidth: number;
  /** リポジトリタブに現在情報（ブランチ名と HEAD の件名）を出すか（決定 24）。 */
  readonly tabShowCurrentInfo: boolean;
  readonly paneWidths: { readonly left: number; readonly center: number; readonly centerRatio: number | null };
  readonly branchLocalHeight: number;
  readonly branchPaneCollapsed: boolean;
  /** リポジトリの絶対パス → ブランチペインで展開中のフォルダ（"local:" / "remote:" 前置き）。 */
  readonly branchExpanded: Readonly<Record<string, readonly string[]>>;
  readonly commandLogHeight: number;
  readonly stagedHeight: number;
  readonly refocusUpdateMode: 'auto' | 'modal' | 'none';
  readonly recentRepositories: readonly string[];
  readonly openRepositories: readonly string[];
}

// ---------------------------------------------------------------- セッション

export interface SessionDto {
  readonly id: string;
  readonly root: string;
  readonly displayName: string;
}

export interface HeadInfoDto {
  readonly oid: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
}

export interface SessionListDto {
  readonly sessions: readonly SessionDto[];
  readonly activeId: string | null;
}

export type RefreshScope = 'status' | 'full';

// ---------------------------------------------------------------- status

export type StatusCodeDto = '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!';
export type EntryKindDto = 'ordinary' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';
export type StatusGroupDto = 'staged' | 'unstaged' | 'untracked' | 'unmerged' | 'changes';

export interface FileEntryDto {
  readonly kind: EntryKindDto;
  readonly path: string;
  readonly origPath?: string;
  readonly staged: StatusCodeDto;
  readonly worktree: StatusCodeDto;
  readonly score?: number;
}

export interface StatusCountsDto {
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly unmerged: number;
  readonly total: number;
}

export interface SessionStateDto {
  readonly id: string;
  /** status スナップショットの世代番号。 */
  readonly statusSeq: number;
  readonly head: HeadInfoDto | null;
  readonly counts: StatusCountsDto;
}

export interface StatusFilterDto {
  readonly group?: StatusGroupDto;
  readonly query?: string;
}

export interface StatusPageRequest {
  readonly offset: number;
  readonly limit: number;
  readonly filter?: StatusFilterDto;
}

export interface StatusPageDto {
  readonly seq: number;
  readonly offset: number;
  readonly entries: readonly FileEntryDto[];
  readonly filteredTotal: number;
}

export interface StatusSummaryDto {
  readonly seq: number;
  readonly counts: StatusCountsDto;
  readonly head: HeadInfoDto | null;
  readonly hasSnapshot: boolean;
}

/**
 * 操作対象の指定。
 * 10 万件のパス配列を renderer から送り返させないため、
 * 'all' / 'filtered' は main 側のスナップショットから解決する。
 */
export type OperationTargetDto =
  | { readonly kind: 'all' }
  | { readonly kind: 'filtered'; readonly filter: StatusFilterDto }
  | { readonly kind: 'paths'; readonly paths: readonly string[] };

export interface OperationResultDto {
  /** 実際に対象となった件数。 */
  readonly affected: number;
  readonly statusSeq: number;
}

export interface CommitRequest {
  readonly message: string;
  readonly amend: boolean;
}

export interface CommitResultDto {
  readonly oid: string | null;
  readonly statusSeq: number;
}

// ---------------------------------------------------------------- diff / log / branch

export type DiffLineKindDto = 'context' | 'added' | 'removed' | 'no-newline';

export interface DiffLineDto {
  readonly kind: DiffLineKindDto;
  readonly text: string;
  readonly oldLineNo: number | null;
  readonly newLineNo: number | null;
}

export interface DiffHunkDto {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLineDto[];
}

export interface FileDiffDto {
  readonly path: string;
  readonly oldPath: string | null;
  readonly binary: boolean;
  readonly hunks: readonly DiffHunkDto[];
  readonly truncated: boolean;
  /**
   * hunk / 行単位の操作ができるか（対応表 #33 / #34）。
   *
   * false になるのは、バイナリ / 行数打ち切り / 未追跡 / ファイル全体の追加・削除 /
   * リネーム / 未マージ / hunk なし。判定は main 側の 1 箇所で行い、
   * ボタンの出し分けと apply 前のガードで同じ結果を使う。
   */
  readonly hunkStageable: boolean;
}

/** hunk / 行の指定。header と lineCount は「表示していたものと同じか」の指紋。 */
export interface HunkSelectionDto {
  /** FileDiffDto.hunks のインデックス。 */
  readonly index: number;
  readonly header: string;
  readonly lineCount: number;
  /** hunk.lines のインデックス。null なら hunk 全体。 */
  readonly lines: readonly number[] | null;
}

export interface HunkStageRequest {
  readonly path: string;
  readonly hunks: readonly HunkSelectionDto[];
}

export interface CommitSummaryDto {
  readonly oid: string;
  readonly shortOid: string;
  /** 親の oid。先頭が第一親。2 つ以上ならマージコミット。グラフのレーン計算に使う。 */
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authoredAt: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committedAt: string;
  readonly subject: string;
  /** 件名を除いた本文。一覧取得（#20）でまとめて取る（コミットを選ぶたびに git を増やさないため）。 */
  readonly body: string;
}

/** コミットの中で変わったファイル 1 件（対応表 #21）。 */
export interface CommitFileChangeDto {
  /** git の生の状態文字（'M' / 'A' / 'D' / 'R100' など）。 */
  readonly status: string;
  readonly path: string;
  /** R / C のときの元パス。それ以外は null。 */
  readonly origPath: string | null;
}

export interface BranchDto {
  readonly refName: string;
  readonly shortName: string;
  readonly isRemote: boolean;
  readonly isHead: boolean;
  readonly oid: string;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly gone: boolean;
  readonly committedAt: string;
  readonly subject: string;
}

export interface BranchSwitchResultDto {
  readonly statusSeq: number;
}

export interface BranchCreateRequest {
  readonly name: string;
  readonly startPoint: string;
}

export interface BranchCreateResultDto {
  readonly statusSeq: number;
}

export interface BranchMergeResultDto {
  readonly statusSeq: number;
}

/** リモート操作（対応表 #22〜#25）の結果。マージと同じく世代番号だけを返す。 */
export interface RemoteResultDto {
  readonly statusSeq: number;
}

export interface PushRequest {
  readonly remote: string;
  readonly branch: string;
  /** 真なら --set-upstream（対応表 #25）。上流がまだ無いブランチに使う。 */
  readonly setUpstream: boolean;
}

/**
 * クローン（対応表 #37）の入力。
 * main は parentDir が存在するディレクトリであること、name が 1 階層のフォルダ名であること、
 * url が `-` で始まらないことを検証してから git に渡す。
 */
export interface CloneRequest {
  readonly url: string;
  /** 保存先の親フォルダ（絶対パス）。 */
  readonly parentDir: string;
  /** 作成するフォルダ名。区切り文字を含まない。 */
  readonly name: string;
  /** 真なら `--depth 1`。 */
  readonly shallow: boolean;
}

// ---------------------------------------------------------------- 診断と通知

export interface CommandLogEntryDto {
  readonly seq: number;
  readonly at: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly elapsedMs: number;
  readonly stderr?: string;
}

export interface SessionChangedEvent {
  readonly sessionId: string;
  readonly change: 'status' | 'branches' | 'remotes' | 'log';
  readonly statusSeq: number;
}

/**
 * 進捗の行（git の stderr を CR / LF で切ったもの）。docs/01-architecture.md 6 章。
 * 今の送り手はクローン（対応表 #37）だけ。
 */
export interface ProgressEvent {
  /** セッションが立つ前の操作（クローン）では null。 */
  readonly sessionId: string | null;
  readonly opId: string;
  readonly line: string;
}

/**
 * git の実行が始まった／終わった（決定 26）。コマンドバーに出す。
 * コマンドログ（CommandLogEntryDto）は終わったものしか持たないので、こちらが実行中を担う。
 */
export interface CommandStartEvent {
  readonly sessionId: string;
  /** 開始と終了を突き合わせる識別子。 */
  readonly opId: string;
  /** コマンドログと同じ短いラベル。 */
  readonly args: readonly string[];
}

export interface CommandEndEvent {
  readonly opId: string;
}

/** ウィンドウ復帰時、refocusUpdateMode が 'modal' のときに送る「更新しますか」通知。 */
export interface FocusRefreshPromptEvent {
  readonly sessionId: string;
}

// ---------------------------------------------------------------- 公開 API

/** preload が contextBridge で renderer に公開する API の形。 */
export interface FeatherTreeBridge {
  appGetInfo(): Promise<Result<AppInfoDto>>;
  appGetEnvironment(): Promise<Result<EnvironmentDto>>;

  settingsGet(): Promise<Result<SettingsDto>>;
  settingsUpdate(patch: Partial<SettingsDto>): Promise<Result<SettingsDto>>;

  /**
   * リポジトリを開く 2 段階のうちの 1 段目。
   * フォルダ選択 → 対応表 #1（ルート解決）だけを行い、タブを立てて返す。
   * 一覧（#2 〜 #4）は取らないので、巨大リポジトリでもすぐ返る。
   * キャンセルされたら null。
   */
  sessionPickAndCreate(): Promise<Result<SessionDto | null>>;
  /**
   * 2 段目。対応表 #2 → #3 → #4 を実行する。時間がかかるのはこちら。
   * renderer は 1 段目でタブを立ててアクティブにしてから呼ぶ
   * （そうしないと実行中の git がコマンドバーに映らない）。
   * 既に読み込み済みなら git を 1 度も実行しない。
   */
  sessionLoad(id: string): Promise<Result<null>>;
  /** 1 段目と 2 段目をまとめて行う。UI からは使わない（テストと将来の CLI 用）。 */
  sessionOpen(root: string): Promise<Result<SessionDto>>;
  /** クローンの保存先（親フォルダ）を選ぶ。キャンセルされたら null。git は動かない。 */
  clonePickDirectory(): Promise<Result<string | null>>;
  /**
   * クローンしてタブを立てる。対応表 #37 → #1 で、sessionPickAndCreate と同じ「1 段目」。
   * 実行中は event:progress（sessionId: null）で進捗行が届く。
   * 一覧（#2 〜 #4）は取らないので、renderer はタブを立ててから sessionLoad を呼ぶ。
   */
  sessionCloneAndCreate(req: CloneRequest): Promise<Result<SessionDto>>;
  sessionList(): Promise<Result<SessionListDto>>;
  sessionActivate(id: string): Promise<Result<null>>;
  sessionClose(id: string): Promise<Result<null>>;
  sessionRefresh(id: string, scope: RefreshScope): Promise<Result<SessionStateDto>>;
  sessionReorder(order: readonly string[]): Promise<Result<null>>;

  statusGetSummary(id: string): Promise<Result<StatusSummaryDto>>;
  statusGetPage(id: string, req: StatusPageRequest): Promise<Result<StatusPageDto>>;

  stage(id: string, target: OperationTargetDto): Promise<Result<OperationResultDto>>;
  unstage(id: string, target: OperationTargetDto): Promise<Result<OperationResultDto>>;
  stageHunks(id: string, req: HunkStageRequest): Promise<Result<OperationResultDto>>;
  unstageHunks(id: string, req: HunkStageRequest): Promise<Result<OperationResultDto>>;
  discard(id: string, target: OperationTargetDto, confirmed?: boolean): Promise<Result<OperationResultDto>>;
  deleteUntracked(
    id: string,
    target: OperationTargetDto,
    confirmed?: boolean,
  ): Promise<Result<OperationResultDto>>;
  commit(id: string, req: CommitRequest, confirmed?: boolean): Promise<Result<CommitResultDto>>;

  diffGet(id: string, path: string, staged: boolean): Promise<Result<FileDiffDto | null>>;
  logGetPage(id: string, skip: number): Promise<Result<readonly CommitSummaryDto[]>>;
  /** 対応表 #21。マージコミットでは空配列（`git show` の既定）。 */
  commitGetFiles(id: string, oid: string): Promise<Result<readonly CommitFileChangeDto[]>>;
  /**
   * 対応表 #36: コミット内の 1 ファイルの diff。
   *
   * 戻りは作業ツリーの diff と同じ `FileDiffDto` を使い回す。**`hunkStageable` は常に false**
   * （過去のコミットからステージすることはできない）。DTO を分けないのは、
   * 差分の描画側が同じ形だけを相手にできるようにするため。
   */
  commitGetDiff(id: string, oid: string, path: string): Promise<Result<FileDiffDto | null>>;
  branchList(id: string): Promise<Result<readonly BranchDto[]>>;
  branchSwitch(id: string, branchName: string): Promise<Result<BranchSwitchResultDto>>;
  branchCreate(id: string, req: BranchCreateRequest): Promise<Result<BranchCreateResultDto>>;
  branchMerge(id: string, branchName: string, confirmed?: boolean): Promise<Result<BranchMergeResultDto>>;
  /** リモート名の一覧（対応表 #4 の結果のキャッシュ。git は走らない）。 */
  remoteList(id: string): Promise<Result<readonly string[]>>;
  remoteFetch(id: string, remote: string): Promise<Result<RemoteResultDto>>;
  remotePull(id: string): Promise<Result<RemoteResultDto>>;
  remotePush(id: string, req: PushRequest): Promise<Result<RemoteResultDto>>;

  shellOpenPath(id: string, path: string): Promise<Result<void>>;
  shellShowInFolder(id: string, path: string): Promise<Result<void>>;
  /**
   * リポジトリを外部ターミナルで開く（決定 26）。
   * パスを渡さないのは意図的。**どこを開くかは main が持つセッションから決める**。
   */
  shellOpenTerminal(id: string): Promise<Result<void>>;

  commandLogRecent(limit: number): Promise<Result<readonly CommandLogEntryDto[]>>;

  /** 購読解除用の関数を返す。 */
  onSessionChanged(listener: (event: SessionChangedEvent) => void): () => void;
  onProgress(listener: (event: ProgressEvent) => void): () => void;
  onFocusRefreshPrompt(listener: (event: FocusRefreshPromptEvent) => void): () => void;
  onCommandStart(listener: (event: CommandStartEvent) => void): () => void;
  onCommandEnd(listener: (event: CommandEndEvent) => void): () => void;
}
