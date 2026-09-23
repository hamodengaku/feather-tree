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
  dialogPickFile: 'dialog:pickFile',
  gitConfigGetIdentity: 'gitConfig:getIdentity',
  gitConfigSetIdentity: 'gitConfig:setIdentity',
  sshSetKey: 'ssh:setKey',

  sessionPickAndCreate: 'session:pickAndCreate',
  sessionLoad: 'session:load',
  sessionOpen: 'session:open',
  clonePickDirectory: 'clone:pickDirectory',
  sessionCloneAndCreate: 'session:cloneAndCreate',
  cloneCancel: 'clone:cancel',
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
  conflictGet: 'conflict:get',
  conflictResolve: 'conflict:resolve',
  logGetPage: 'log:getPage',
  commitGetFiles: 'commit:getFiles',
  commitGetDiff: 'commit:getDiff',
  branchList: 'branch:list',
  branchSwitch: 'branch:switch',
  branchCreate: 'branch:create',
  branchMerge: 'branch:merge',

  stashList: 'stash:list',
  stashSave: 'stash:save',
  stashApply: 'stash:apply',
  stashDrop: 'stash:drop',
  stashGetFiles: 'stash:getFiles',
  stashGetDiff: 'stash:getDiff',

  // Unity Prefab 差分モード（決定 32）
  unityGetView: 'unity:getView',
  unityGetNode: 'unity:getNode',
  unityIndexScripts: 'unity:indexScripts',

  remoteList: 'remote:list',
  remoteFetch: 'remote:fetch',
  remotePull: 'remote:pull',
  remotePush: 'remote:push',

  shellOpenPath: 'shell:openPath',
  shellShowInFolder: 'shell:showInFolder',
  shellOpenTerminal: 'shell:openTerminal',

  commandLogRecent: 'diag:commandLog',

  // 更新通知（決定 29）
  updateGetState: 'update:getState',
  updateCheckNow: 'update:checkNow',
  updateOpenReleasePage: 'update:openReleasePage',
  updateDismiss: 'update:dismiss',

  // main -> renderer の通知
  eventSessionChanged: 'event:sessionChanged',
  eventProgress: 'event:progress',
  eventCloneProgress: 'event:cloneProgress',
  eventFocusRefreshPrompt: 'event:focusRefreshPrompt',
  eventCommandStart: 'event:commandStart',
  eventCommandEnd: 'event:commandEnd',
  eventCommandLogged: 'event:commandLogged',
  eventUpdateAvailable: 'event:updateAvailable',
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
  /**
   * GIT_SSH_COMMAND に埋める ssh の絶対パス（決定 13 の追記）。未検出なら null。
   * null のときは鍵を登録しても何も注入されない（bare 名は渡さないため）。
   */
  readonly sshPath: string | null;
  /**
   * `git stash push --staged`（対応表 #27）が使えるか＝ **git 2.35 以降か**（決定 31）。
   *
   * アプリの最低要求は 2.25 のままなので、古い git でも他の機能は動く。
   * 偽のときは Stash 保存モードの**保存だけ**を止め、理由を画面に出す。
   * 判定を renderer へ渡すのは、押せないボタンを押させないため
   * （main 側でも同じ判定で拒否するので、これは表示のためだけの値）。
   */
  readonly supportsStagedStash: boolean;
  /** 古い git などの警告。無ければ null。 */
  readonly warning: string | null;
}

/**
 * ファイル選択ダイアログの用途。
 *
 * renderer は「何を選ばせたいか」だけを送り、フィルタも初期フォルダも main が決める
 * （clonePickDirectory が openDirectory を main 側で固定しているのと同じ思想）。
 */
export type PickFileKindDto = 'git-executable' | 'ssh-private-key';

/* ------------------------------------------------ コミット情報（対応表 #42〜#44） */

/**
 * その値がどこから来ているか。
 * 'inherited' は「このリポジトリには無く、全体設定（global / system）の値が使われている」。
 * 設定画面はこのときだけ警告を出す。
 */
export type GitIdentityScopeDto = 'local' | 'inherited' | 'unset';

export interface GitIdentityFieldDto {
  readonly value: string | null;
  readonly scope: GitIdentityScopeDto;
}

export interface GitIdentityDto {
  readonly name: GitIdentityFieldDto;
  readonly email: GitIdentityFieldDto;
}

/**
 * 保存する値。**null は「このキーは変更しない」**（消す指示ではない）。
 * 空文字は main が拒否する——ローカルの設定を消すと全体設定の値に黙って戻るため、
 * 削除はアプリからは行わない（決定 13 の追記）。
 */
export interface GitIdentityRequest {
  readonly name: string | null;
  readonly email: string | null;
}

export interface SettingsDto {
  readonly gitPath: string | null;
  /**
   * SSH 秘密鍵（決定 13 の追記）。**リポジトリの絶対パス → 鍵の絶対パス**。
   * このアプリが実行する git にだけ GIT_SSH_COMMAND として渡る。
   * 登録の無いリポジトリには何も注入しない。
   */
  readonly sshKeyPaths: Readonly<Record<string, string>>;
  readonly theme: 'classic-dark' | 'classic-light' | 'phoenix-dark' | 'phoenix-light';
  readonly noRenames: boolean;
  readonly diffContextLines: number;
  readonly diffMaxLines: number;
  readonly logPageSize: number;
  /** ペイン領域のモード（決定 27 / 31 / 32）。core の ViewMode と同じ 5 値。 */
  readonly viewMode: 'diff' | 'log' | 'stash' | 'stash-list' | 'unity';
  readonly logDetailHeight: number;
  readonly commitFileListWidth: number;
  /** Stash 解放モードの下部（stash 詳細）ペインの高さ（px）。 */
  readonly stashDetailHeight: number;
  /** stash 詳細ペインの、左のファイルリストの幅（px）。 */
  readonly stashFileListWidth: number;
  /** Unity ペインの、左の Prefab ヒエラルキーの幅（px）。決定 32。 */
  readonly unityHierarchyWidth: number;
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

  /** 起動時の自動確認（決定 29）。オフなら手動確認のみ。 */
  readonly checkForUpdates: boolean;
  /** 最後に確認を試みた時刻（epoch ms）。未確認は null。 */
  readonly lastUpdateCheckAt: number | null;
  /** 「この版は通知しない」で選んだバージョン（'x.y.z'）。 */
  readonly dismissedUpdateVersion: string | null;
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

/* ------------------------------------------------ コンフリクト（マーカーの表示と採用） */

/**
 * 1 行の役割。
 *  - marker: `<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` の行そのもの
 *  - base: diff3 スタイルの共通祖先（設定していなければ現れない）
 */
export type ConflictLineKindDto = 'context' | 'marker' | 'ours' | 'base' | 'theirs';

export interface ConflictLineDto {
  readonly kind: ConflictLineKindDto;
  readonly text: string;
  /** 作業ツリーのファイル内の行番号（1 始まり）。 */
  readonly lineNo: number;
}

/** 画面に出す 1 衝突分。diff の hunk に相当し、操作のボタンもここに付く。 */
export interface ConflictSectionDto {
  readonly index: number;
  readonly startLine: number;
  readonly endLine: number;
  /** `<<<<<<< HEAD` の `HEAD`。ラベルが無ければ空文字。 */
  readonly ourLabel: string;
  readonly theirLabel: string;
  readonly baseLabel: string | null;
  readonly ourCount: number;
  readonly theirCount: number;
  readonly lines: readonly ConflictLineDto[];
  readonly truncated: boolean;
}

export interface ConflictFileDto {
  readonly path: string;
  readonly binary: boolean;
  /**
   * マーカーの対応が取れていない（入れ子・閉じていない）。
   * 読めたところまでは `sections` に入るが、**採用のボタンは出さない**（外部ツールに委ねる）。
   */
  readonly malformed: boolean;
  readonly sections: readonly ConflictSectionDto[];
  readonly truncated: boolean;
}

/**
 * 1 ブロックの採り方。`ours-theirs` / `theirs-ours` は**両方を残す**（違いは順序だけ）。
 * これより込み入った解決（片側の一部だけを採る等）はアプリでは行わない。
 */
export type ConflictChoiceDto = 'ours' | 'theirs' | 'ours-theirs' | 'theirs-ours';

/** どの衝突か。行番号と各側の行数は「表示していたものと同じか」の指紋。 */
export interface ConflictSelectionDto {
  readonly index: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly ourCount: number;
  readonly theirCount: number;
}

export interface ConflictResolveRequest {
  readonly path: string;
  readonly section: ConflictSelectionDto;
  readonly choice: ConflictChoiceDto;
}

export interface ConflictResolveResultDto {
  /** そのファイルに残っている衝突の数。0 ならステージして解決済みにできる。 */
  readonly remaining: number;
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

/* ------------------------------------------------ Unity Prefab 差分（決定 32） */

/**
 * そのファイルを展開できたか。
 *  - `yaml`       … テキストの Unity YAML。ヒエラルキーと表を出す
 *  - `binary`     … バイナリシリアライズ / LFS のポインタ。「展開できません」
 *  - `not-prefab` … `.prefab` / `.unity` ではない。「Prefab ではありません」
 */
export type UnityFormatDto = 'yaml' | 'binary' | 'not-prefab';

/** ヒエラルキーの印（要件 7）。 */
export type UnityNodeMarkDto = 'same' | 'changed' | 'added' | 'removed' | 'moved';

export type UnityNodeKindDto = 'gameObject' | 'component' | 'prefabInstance';

/**
 * ヒエラルキーの 1 ノード。**平坦な配列＋親の添字**で持つ。
 *
 * 入れ子の JSON にしないのは、構造化クローンが深さに弱く、
 * renderer の仮想リストも平坦な配列を欲しがるため（決定 32）。
 */
export interface UnityNodeDto {
  /** fileID（anchor）。ノードの同一性はこれで見る。 */
  readonly id: string;
  /** 親の添字。ルートは -1。 */
  readonly parent: number;
  readonly depth: number;
  readonly kind: UnityNodeKindDto;
  readonly classId: number;
  readonly name: string;
  readonly mark: UnityNodeMarkDto;
  /**
   * 子孫のどこかに `same` 以外が居るか。
   * 「変更のある節までの経路だけ自動展開」（要件 7）を renderer が 1 回のなめで組める。
   */
  readonly hasChangedDescendant: boolean;
}

export interface UnityViewDto {
  readonly path: string;
  readonly staged: boolean;
  readonly format: UnityFormatDto;
  /** ヒエラルキー全体。プロパティの表は**選んだときに** `unityGetNode` で取る。 */
  readonly nodes: readonly UnityNodeDto[];
  /**
   * ステージ操作ができるか。false の理由は `refusal`。
   *
   * **できないときも表示は出す**（読む機能は行の対応と関係が無い）。
   * 判定を main 側の 1 か所で行うのは `FileDiffDto.hunkStageable` と同じ理由で、
   * 「UI では押せるのに main が拒否する」ずれを作らないため。
   */
  readonly stageable: boolean;
  /**
   * ステージできない理由。`binary` / `truncated` / `synthesized` / `whole-file` /
   * `rename` / `combined` / `no-hunk` / `empty-selection` / `no-such-hunk` に加えて、
   * `alignment`（改行変換 / LFS で全文と diff が食い違う）と `no-diff`。
   */
  readonly refusal: string | null;
  readonly changedNodeCount: number;
}

export type UnityRowStateDto = 'same' | 'changed' | 'added' | 'removed';

/** プロパティ表の 1 行（要件 8）。 */
export interface UnityRowDto {
  /** 「変数」列。`m_LocalPosition.x` のような道筋。 */
  readonly key: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly state: UnityRowStateDto;
  /**
   * 「1 パラメータだけステージ」で送る座標。**null ならボタンを出さない。**
   *
   * 座標の計算を main 側で済ませておくことで、renderer は既存の
   * `stageHunks` / `unstageHunks` にそのまま流すだけで済む。
   * パッチ本体は依然として renderer を通らない（決定「やらないこと」）。
   */
  readonly selection: readonly HunkSelectionDto[] | null;
  /**
   * その 1 行を押すと**一緒に入ってしまう**他の変更行の数。
   *
   * git が扱えるのは行までなので、`{x: 2.5, y: 3, z: 1}` の x と y が両方
   * 変わっていたら片方だけは入れられない。押す前に分かるようボタンの説明に添える。
   */
  readonly alsoStages: number;
}

/** guid の索引を作った結果（要件 11）。 */
export interface UnityScriptIndexDto {
  /** 名前を引けるようになった guid の数。 */
  readonly resolved: number;
}

export interface UnityNodeDetailDto {
  readonly nodeId: string;
  readonly rows: readonly UnityRowDto[];
  /** 「コンポーネントをステージ」で送る座標。null ならボタンを出さない。 */
  readonly selection: readonly HunkSelectionDto[] | null;
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

/* ------------------------------------------------ stash（決定 31 / 対応表 #27〜#31、#45、#46） */

/**
 * stash スタックの 1 件。
 *
 * **識別子を 2 つ持つ**のは git の都合そのもの: `pop` / `drop` は `stash@{n}` しか
 * 受け付けず（生の oid は `is not a stash reference`）、その n は pop / drop のたびに
 * ずれる。読み取り（#45 / #46）は oid で行うので番号のずれに巻き込まれない。
 */
export interface StashEntryDto {
  /** `stash@{n}` の n。新しいものが 0。 */
  readonly index: number;
  /** `stash@{n}` そのもの。表示にも使う。 */
  readonly ref: string;
  readonly oid: string;
  readonly shortOid: string;
  /** ISO 8601。 */
  readonly authoredAt: string;
  /** reflog の件名（`On main: 退避のメモ`）。 */
  readonly message: string;
  /**
   * **このアプリが作った stash か**（親が 2 つ＝ HEAD と index コミット）。
   *
   * 偽なら外部で `-u` 付きに作られたもので、未追跡としてだけ入っているファイルが
   * ありうる（main はそれを 2 回目の diff で拾う）。画面では印を出すだけ。
   */
  readonly staged: boolean;
}

/**
 * どの stash か。**oid は「一覧に出していたものと同じか」の指紋**。
 *
 * hunk 適用の `HunkSelectionDto` と同じ思想だが、こちらは外すと**不可逆**
 * （別の stash を drop する）なので、main は打つ直前に #28 を取り直して照合する。
 */
export interface StashRefDto {
  readonly index: number;
  readonly oid: string;
}

/**
 * stash を動かす操作の結果。**取り直した一覧をそのまま載せる**
 * （どの操作でも一覧は必ず変わりうるので、載せないと必ず 2 回目の IPC が要る）。
 */
export interface StashResultDto {
  readonly statusSeq: number;
  readonly stashes: readonly StashEntryDto[];
}

export interface StashApplyRequest {
  readonly stash: StashRefDto;
  /** 真なら `stash pop`（展開して消す）、偽なら `stash apply`（展開して残す）。 */
  readonly drop: boolean;
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
  /**
   * 切替に伴ってブランチ一覧（対応表 #3）も取り直したかどうか。
   *
   * 真になるのは、リモートにだけあるブランチへ切り替えたとき（git の DWIM が
   * ローカル追跡ブランチを新しく作る）。**その判定は main が自分の一覧で行う**ので、
   * renderer はこの値を見てブランチペインを読み直すかどうかだけを決める。
   * 偽のときに読み直しても main のスナップショットは切替前のままで、IPC が無駄に増える。
   */
  readonly branchesRefreshed: boolean;
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
 * クローンの方法（決定 9）。
 * shallow は `--depth 1`、large は shallow → LFS 一括取得 → refspec 設定 → unshallow の自動実行（対応表 #37〜#41）。
 */
export type CloneMode = 'normal' | 'shallow' | 'large';

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
  readonly mode: CloneMode;
  /**
   * このクローンに使う SSH 秘密鍵の絶対パス（決定 9 の追記）。null なら使わない
   * （ssh-agent / ~/.ssh/config に任せる）。鍵はリポジトリごとに持つ（決定 13）が、
   * クローンの時点ではまだリポジトリが無いのでここで受け取り、
   * 成功したらそのリポジトリの設定として保存する。
   */
  readonly sshKeyPath?: string | null;
}

export type CloneStageState = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';

/**
 * クローンの進捗の 1 段階（1 行）。段階表は始まる前にすべて並ぶ。
 * 行の解析は main（core）で済ませてあり、renderer は git の出力形式を知らない。
 */
export interface CloneStageDto {
  readonly id: string;
  /** 日本語の段階名。 */
  readonly label: string;
  /** git の原文名（Receiving objects 等）。 */
  readonly source: string;
  /** 見出しのまとまり。 */
  readonly group: 'clone' | 'lfs' | 'config' | 'unshallow';
  readonly step: string;
  readonly state: CloneStageState;
  /** 0〜100。件数だけの段階や未開始は null。 */
  readonly percent: number | null;
  readonly current: number | null;
  readonly total: number | null;
  /** 転送量と速度（`1.20 MiB | 2.00 MiB/s`）。 */
  readonly detail: string | null;
  /** epoch ms。 */
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

/** 失敗時のヒントや警告（docs/02-git-command-map.md「クローン失敗時のヒント」）。 */
export interface CloneHintDto {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** 利用者がターミナルで打つコマンド。アプリは実行しない。 */
  readonly commands: readonly string[];
}

/**
 * クローンの結果。git の失敗・中止も IPC のエラーにせず、これで返す（ダイアログにヒントを出すため）。
 *  - succeeded: 全手順が済んだ（警告のヒントはありうる）
 *  - partial: クローンはできたが、途中の手順が失敗・中止した（session は立っている）
 *  - failed: クローンできなかった（session は null）
 */
export interface CloneOutcomeDto {
  readonly result: 'succeeded' | 'partial' | 'failed';
  readonly cancelled: boolean;
  readonly session: SessionDto | null;
  /** クローン先のフォルダ。 */
  readonly target: string;
  readonly stages: readonly CloneStageDto[];
  readonly hints: readonly CloneHintDto[];
  /** クローンしたフォルダで後から打つコマンド（シャローの推奨・大規模の残り手順）。 */
  readonly followUps: readonly string[];
  /** コピー用の生ログ。 */
  readonly log: string;
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
  /** どのタブの実行か。タブに属さない実行（セッションが立つ前のクローン）は null。 */
  readonly sessionId: string | null;
}

export interface SessionChangedEvent {
  readonly sessionId: string;
  readonly change: 'status' | 'branches' | 'remotes' | 'log';
  readonly statusSeq: number;
}

/**
 * 進捗の行（git の stderr を CR / LF で切ったもの）。docs/01-architecture.md 6 章。
 * fetch / push / ブランチ切替の進捗のための型で、今は送り手がいない（クローンは CloneProgressEvent）。
 */
export interface ProgressEvent {
  readonly sessionId: string;
  readonly opId: string;
  readonly line: string;
}

/** クローンの進捗。段階表のスナップショットを丸ごと送る（main で 200ms に間引く）。 */
export interface CloneProgressEvent {
  readonly opId: string;
  readonly stages: readonly CloneStageDto[];
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

// ---------------------------------------------------------------- 更新通知（決定 29）

/**
 * 確認の結果。
 *  - unknown: まだ 1 度も確認していない（起動直後、自動確認がまだ届いていない等）
 *  - up-to-date: 確認できて、新版は無かった（dismissed で隠した場合も含む）
 *  - new-version: 新版がある（version に 'x.y.z'）
 *  - failed: 確認できなかった（非 200・JSON 不正・タイムアウト・オフライン等）
 */
export type UpdateOutcomeDto = 'unknown' | 'up-to-date' | 'new-version' | 'failed';

export interface UpdateStateDto {
  readonly outcome: UpdateOutcomeDto;
  /** outcome が 'new-version' のときだけ値を持つ。 */
  readonly version: string | null;
}

/** 起動時の自動確認で新版が見つかったときの通知。renderer 準備前に届いた分は updateGetState で取り直す。 */
export interface UpdateAvailableEvent {
  readonly version: string;
}

// ---------------------------------------------------------------- 公開 API

/** preload が contextBridge で renderer に公開する API の形。 */
export interface FeatherTreeBridge {
  appGetInfo(): Promise<Result<AppInfoDto>>;
  appGetEnvironment(): Promise<Result<EnvironmentDto>>;

  settingsGet(): Promise<Result<SettingsDto>>;
  settingsUpdate(patch: Partial<SettingsDto>): Promise<Result<SettingsDto>>;
  /**
   * 設定画面のファイル選択（git.exe / SSH 秘密鍵）。キャンセルなら null。git は動かない。
   * 選んだだけでは保存しない——保存は settingsUpdate で行う。
   */
  dialogPickFile(kind: PickFileKindDto): Promise<Result<string | null>>;

  /**
   * 対応表 #42（→ 必要なら #43）: そのリポジトリのコミット情報を読む。
   * ローカルに無い項目は全体設定の値と 'inherited' が返る（設定画面が警告を出す）。
   */
  gitConfigGetIdentity(id: string): Promise<Result<GitIdentityDto>>;
  /**
   * 対応表 #44: コミット情報を**そのリポジトリの .git/config** に保存する。
   * 変えるキーだけを送る（null は変更しない）。global / system は書き換えない。
   *
   * 保存後に読み直さないので応答は null。書いたキーがローカル値になるのは確実なので、
   * renderer は手元の状態を進めればよい（git のプロセスを 1 本増やす意味が無い）。
   */
  gitConfigSetIdentity(id: string, req: GitIdentityRequest): Promise<Result<null>>;

  /**
   * そのリポジトリで使う SSH 秘密鍵を設定する（決定 13 の追記）。null で登録を消す。
   * git は動かない（次に git を実行するときから効く）。
   * **1 リポジトリずつ**の口にしてあるのは、renderer に辞書ごと書き換えさせないため。
   */
  sshSetKey(id: string, keyPath: string | null): Promise<Result<SettingsDto>>;

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
   * クローンしてタブを立てる。対応表 #37〜#41 → #1 で、sessionPickAndCreate と同じ「1 段目」。
   * 実行中は event:cloneProgress で段階表が届く。同時に 1 本だけ（実行中に呼ぶと internal エラー）。
   * git の失敗・中止は ok: true の結果（result: failed / partial）で返る。ok: false は入力検証の違反だけ。
   * 一覧（#2 〜 #4）は取らないので、renderer は session が立っていればタブを立ててから sessionLoad を呼ぶ。
   */
  sessionCloneAndCreate(req: CloneRequest): Promise<Result<CloneOutcomeDto>>;
  /** 実行中のクローンを中止する。実行中でなければ何もしない。 */
  cloneCancel(): Promise<Result<null>>;
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
  /**
   * 未マージファイルのコンフリクトマーカーを読む。**git は 1 度も動かない**
   * （`git diff` は未マージに結合 diff を出すだけでマーカーの中身を返さないため、
   * 作業ツリーのファイルを直接読む。未追跡ファイルの diff と同じ考え方）。
   *
   * 作業ツリーにファイルが無ければ（削除との衝突）null。
   */
  conflictGet(id: string, path: string): Promise<Result<ConflictFileDto | null>>;
  /**
   * 衝突 1 件を採用して作業ツリーへ書き戻す。**git は 1 度も動かない。**
   *
   * インデックスには触れないので、解決済みにするには利用者がステージする（素の git と同じ手順）。
   * 書く直前にファイルを読み直し、指紋が食い違えば `diff-stale` で断る。
   */
  conflictResolve(id: string, req: ConflictResolveRequest): Promise<Result<ConflictResolveResultDto>>;
  /**
   * Unity モードのヒエラルキー（決定 32）。
   *
   * **ヒエラルキーだけを返し、プロパティの表は含めない。** 全ノードの全行を 1 回で
   * 送ると 20MB のシーンで 100MB 超の構造化クローンになり、同期処理なので画面が数秒止まる。
   * ツリーだけなら 2 万ノードで 1.6MB 程度に収まる。
   *
   * `.prefab` / `.unity` 以外や、バイナリシリアライズでも**エラーにはしない**。
   * `format` にその旨が入るので、画面は案内を出す。
   */
  unityGetView(id: string, path: string, staged: boolean): Promise<Result<UnityViewDto>>;
  /** 選んだ 1 ノードのプロパティ表。ここで初めて本体のパースが走る。 */
  unityGetNode(
    id: string,
    path: string,
    staged: boolean,
    nodeId: string,
  ): Promise<Result<UnityNodeDetailDto | null>>;
  /**
   * リポジトリ内の `*.meta` を走査して guid -> スクリプト名 / Prefab 名の索引を作る（要件 11）。
   *
   * **git は 1 プロセスも起動しない**（Node のファイル走査だけ）。
   * 巨大プロジェクトでは数千ファイルを読むので、**利用者が押したときだけ**呼ぶ。
   * 1 度作ったらセッションの間は使い回す。
   */
  unityIndexScripts(id: string): Promise<Result<UnityScriptIndexDto>>;
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
  /**
   * 対応表 #28: stash の一覧。**呼ぶたびに git が 1 回走る**（branchList と違い
   * main はスナップショットを持たない）。Stash 解放モードに入った瞬間に 1 回だけ呼ぶ。
   */
  stashList(id: string): Promise<Result<readonly StashEntryDto[]>>;
  /**
   * 対応表 #27: **ステージした差分だけ**を stash に退避する（決定 31）。
   *
   * 失敗しても stash だけができていることがあるので（`Cannot remove worktree changes`）、
   * renderer は**失敗時も status と一覧を取り直す**。
   */
  stashSave(id: string, message: string): Promise<Result<StashResultDto>>;
  /**
   * 対応表 #29 / #30: stash をブランチへ展開する。確認不要。
   * **`--index` は付けない**ので、戻ってくる変更は未ステージ扱いになる。
   */
  stashApply(id: string, req: StashApplyRequest): Promise<Result<StashResultDto>>;
  /** 対応表 #31: stash を破棄。**不可逆なので確認必須**（決定 16）。 */
  stashDrop(id: string, stash: StashRefDto, confirmed?: boolean): Promise<Result<StashResultDto>>;
  /** 対応表 #45: その stash の変更ファイル一覧。参照は oid（番号のずれに巻き込まれない）。 */
  stashGetFiles(id: string, stash: StashRefDto): Promise<Result<readonly CommitFileChangeDto[]>>;
  /**
   * 対応表 #46: stash 内の 1 ファイルの diff。
   *
   * 戻りはコミットの diff と同じ `FileDiffDto` を使い回す。**`hunkStageable` は常に false**
   * （stash から直接ステージすることはできない）。
   */
  stashGetDiff(id: string, stash: StashRefDto, path: string): Promise<Result<FileDiffDto | null>>;
  branchList(id: string): Promise<Result<readonly BranchDto[]>>;
  branchSwitch(id: string, branchName: string): Promise<Result<BranchSwitchResultDto>>;
  branchCreate(id: string, req: BranchCreateRequest): Promise<Result<BranchCreateResultDto>>;
  branchMerge(id: string, branchName: string, confirmed?: boolean): Promise<Result<BranchMergeResultDto>>;
  /** リモート名の一覧（対応表 #4 の結果のキャッシュ。git は走らない）。 */
  remoteList(id: string): Promise<Result<readonly string[]>>;
  remoteFetch(id: string, remote: string): Promise<Result<RemoteResultDto>>;
  remotePull(id: string): Promise<Result<RemoteResultDto>>;
  remotePush(id: string, req: PushRequest): Promise<Result<RemoteResultDto>>;

  /**
   * 実行されうる拡張子（`.exe` 等、判定は `isExecutableFileName`）のときだけ、
   * main が `confirmed` を求める（`needs-confirmation`）。それ以外は無確認で開く（脆弱性診断 §5）。
   */
  shellOpenPath(id: string, path: string, confirmed?: boolean): Promise<Result<void>>;
  shellShowInFolder(id: string, path: string): Promise<Result<void>>;
  /**
   * リポジトリを外部ターミナルで開く（決定 26）。
   * パスを渡さないのは意図的。**どこを開くかは main が持つセッションから決める**。
   */
  shellOpenTerminal(id: string): Promise<Result<void>>;

  commandLogRecent(limit: number): Promise<Result<readonly CommandLogEntryDto[]>>;

  /**
   * 直近の確認結果を取り直す（決定 29）。
   * 起動時の自動確認は renderer の準備前に終わることがあるので、
   * onUpdateAvailable の取りこぼしに備えてここで取り直せるようにしてある。
   */
  updateGetState(): Promise<Result<UpdateStateDto>>;
  /** 手動確認。24 時間の間引きと dismissed を無視して確認し、結果を返す。 */
  updateCheckNow(): Promise<Result<UpdateStateDto>>;
  /**
   * ダウンロードページ（GitHub の releases タグページ）を既定のブラウザで開く。
   * URL や tag は渡さない——main が保持している検証済みの tag から組み立てる。
   */
  updateOpenReleasePage(): Promise<Result<void>>;
  /** 「この版は通知しない」。現在通知中の版を dismissedUpdateVersion に保存する。 */
  updateDismiss(): Promise<Result<void>>;

  /** 購読解除用の関数を返す。 */
  onSessionChanged(listener: (event: SessionChangedEvent) => void): () => void;
  onProgress(listener: (event: ProgressEvent) => void): () => void;
  onCloneProgress(listener: (event: CloneProgressEvent) => void): () => void;
  onFocusRefreshPrompt(listener: (event: FocusRefreshPromptEvent) => void): () => void;
  onCommandStart(listener: (event: CommandStartEvent) => void): () => void;
  onCommandEnd(listener: (event: CommandEndEvent) => void): () => void;
  /**
   * コマンドログに 1 件増えた（全タブ分）。実行ログパネルはこれで増えた分を受け取る
   * （取り直すきっかけが操作の後に限られていると、表示が古いまま残るため）。
   */
  onCommandLogged(listener: (entry: CommandLogEntryDto) => void): () => void;
  /** 起動時の自動確認で新版が見つかった（決定 29）。 */
  onUpdateAvailable(listener: (event: UpdateAvailableEvent) => void): () => void;
}
