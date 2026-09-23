import {
  OPEN_EXECUTABLE_CONFIRMATION,
  SessionOperations,
  canBuildPatch,
  describeAction,
  describeIdentityRejection,
  describeStashMessageRejection,
  displayNameOf,
  gitNotFoundHint,
  isExecutableFileName,
  supportsStagedStash,
  validateIdentityValue,
  validateStashMessage,
  type AppSettings,
  type CloneStage,
  type CommandLog,
  type ConflictChoice,
  type ConflictSelection,
  type DestructiveAction,
  type GitLocation,
  type GitVersionCheck,
  type HunkSelection,
  type RepositorySession,
  type SessionManager,
  type StashSelection,
  type TerminalLaunch,
  rowsFor,
  selectionForNode,
} from '@feathertree/core';
import type {
  AppInfoDto,
  CloneOutcomeDto,
  CloneProgressEvent,
  CloneRequest,
  BranchCreateRequest,
  BranchMergeResultDto,
  HunkStageRequest,
  BranchCreateResultDto,
  BranchDto,
  BranchSwitchResultDto,
  CommandLogEntryDto,
  CommitRequest,
  CommitFileChangeDto,
  CommitResultDto,
  CommitSummaryDto,
  ConflictFileDto,
  ConflictResolveRequest,
  ConflictResolveResultDto,
  EnvironmentDto,
  FileDiffDto,
  GitIdentityDto,
  GitIdentityRequest,
  OperationResultDto,
  OperationTargetDto,
  PickFileKindDto,
  PushRequest,
  RefreshScope,
  RemoteResultDto,
  SessionDto,
  SessionListDto,
  SessionStateDto,
  SettingsDto,
  StashApplyRequest,
  StashEntryDto,
  StashRefDto,
  StashResultDto,
  StatusPageDto,
  StatusPageRequest,
  StatusSummaryDto,
  UnityNodeDetailDto,
  UnityScriptIndexDto,
  UnityViewDto,
} from '@feathertree/ipc';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { assertInsideRoot, assertRealPathInsideRoot } from '@feathertree/base-core';
import { HandlerError } from '../errors.js';
import { toCommandLogEntryDto } from './commandLogDto.js';
import { createProgressThrottle } from './progressThrottle.js';

/** ページで一度に返す最大件数。renderer が巨大な要求を投げても抑える。 */
const MAX_PAGE_LIMIT = 1000;

/** クローンの進捗を renderer へ送る間隔（docs/01-architecture.md 6 章）。 */
const CLONE_PROGRESS_INTERVAL_MS = 200;

/** コンフリクトの採り方。renderer から来た文字列をそのまま core へ渡さないための白名簿。 */
const CONFLICT_CHOICES: ReadonlySet<string> = new Set([
  'ours',
  'theirs',
  'ours-theirs',
  'theirs-ours',
]);

/** 制御文字（改行・NUL など）を含むか。正規表現に書くと no-control-regex に掛かるので文字コードで見る。 */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * 設定に保存するパスの検証（絶対パスであること）。
 *
 * `null` は「指定なし」なので通す。相対パス・bare 名を弾くのは、この値が
 * そのまま spawn の実行ファイル（gitPath）や ssh の引数（sshKeyPath）になるため。
 * normalizeSettings も同じことを見ているが、あちらは**黙って null に落とす**（起動を止めない）。
 * 設定画面から来た値は、黙って捨てずにここで理由を返す。
 */
function assertAbsolutePathSetting(label: string, value: string | null | undefined): void {
  if (value === undefined || value === null) return;
  if (hasControlChar(value)) {
    throw new HandlerError({ kind: 'internal', message: label + 'に使えない文字が含まれています。' });
  }
  if (!isAbsolute(value)) {
    throw new HandlerError({
      kind: 'invalid-path',
      message: label + 'は絶対パスで指定してください（例: C:\\Program Files\\Git\\cmd\\git.exe）。',
    });
  }
}

/**
 * サービスが必要とするもの。
 *
 * electron の型を含めないことで **Electron を起動せずにテストできる**。
 * register.ts は ipcMain とこのサービスを繋ぐだけの薄い層になる。
 */
export interface ServiceDeps {
  readonly appInfo: () => AppInfoDto;
  readonly git: () => GitLocation | null;
  readonly gitVersion: () => GitVersionCheck | null;
  /** GIT_SSH_COMMAND に埋める ssh の絶対パス（決定 13 の追記）。未検出なら null。 */
  readonly sshPath: () => string | null;
  readonly settings: () => AppSettings;
  readonly updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  readonly reloadGit: () => Promise<void>;
  readonly sessions: () => SessionManager | null;
  readonly commandLog: () => CommandLog;
  /** フォルダ選択。キャンセルなら null。 */
  readonly pickDirectory: () => Promise<string | null>;
  /** ファイル選択（設定画面の git.exe / SSH 秘密鍵）。キャンセルなら null。 */
  readonly pickFile: (kind: PickFileKindDto) => Promise<string | null>;
  /** クローンの段階表を renderer へ送る（間引きはサービス側で済ませてから呼ぶ）。 */
  readonly notifyCloneProgress: (event: CloneProgressEvent) => void;
  /** OS 既定のアプリでファイル／フォルダを開く。失敗時はエラー文字列を返す（throw しない）。 */
  readonly openPath: (absolutePath: string) => Promise<string>;
  /** エクスプローラでそのファイルを選択した状態で開く。 */
  readonly showItemInFolder: (absolutePath: string) => void;
  /**
   * そのリポジトリをどのターミナルで開くか（決定 26）。null なら開けるものが無い。
   * 判断は core の locateTerminal が持つ。ここで注入にしているのは、
   * 開発機に何が入っているかでテスト結果が変わらないようにするため。
   */
  readonly resolveTerminal: (cwd: string) => Promise<TerminalLaunch | null>;
  /**
   * ターミナルを 1 つ起動する。
   * 起動の成否は待たない（外部プロセスなので、落ちても本体には関係が無い）。
   */
  readonly launchTerminal: (launch: TerminalLaunch, cwd: string) => void;
}

export interface Service {
  appGetInfo(): AppInfoDto;
  appGetEnvironment(): EnvironmentDto;
  settingsGet(): SettingsDto;
  settingsUpdate(patch: Partial<SettingsDto>): Promise<SettingsDto>;
  dialogPickFile(kind: PickFileKindDto): Promise<string | null>;
  gitConfigGetIdentity(id: string): Promise<GitIdentityDto>;
  gitConfigSetIdentity(id: string, req: GitIdentityRequest): Promise<null>;
  sshSetKey(id: string, keyPath: string | null): Promise<SettingsDto>;
  sessionPickAndCreate(): Promise<SessionDto | null>;
  sessionLoad(id: string): Promise<null>;
  sessionOpen(root: string): Promise<SessionDto>;
  clonePickDirectory(): Promise<string | null>;
  sessionCloneAndCreate(req: CloneRequest): Promise<CloneOutcomeDto>;
  cloneCancel(): null;
  sessionList(): SessionListDto;
  sessionActivate(id: string): Promise<null>;
  sessionClose(id: string): Promise<null>;
  sessionRefresh(id: string, scope: RefreshScope): Promise<SessionStateDto>;
  sessionReorder(order: readonly string[]): Promise<null>;
  statusGetSummary(id: string): StatusSummaryDto;
  statusGetPage(id: string, req: StatusPageRequest): StatusPageDto;
  stage(id: string, target: OperationTargetDto): Promise<OperationResultDto>;
  unstage(id: string, target: OperationTargetDto): Promise<OperationResultDto>;
  stageHunks(id: string, req: HunkStageRequest): Promise<OperationResultDto>;
  unstageHunks(id: string, req: HunkStageRequest): Promise<OperationResultDto>;
  discard(id: string, target: OperationTargetDto, confirmed?: boolean): Promise<OperationResultDto>;
  deleteUntracked(
    id: string,
    target: OperationTargetDto,
    confirmed?: boolean,
  ): Promise<OperationResultDto>;
  commit(id: string, req: CommitRequest, confirmed?: boolean): Promise<CommitResultDto>;
  diffGet(id: string, path: string, staged: boolean): Promise<FileDiffDto | null>;
  conflictGet(id: string, path: string): Promise<ConflictFileDto | null>;
  conflictResolve(id: string, req: ConflictResolveRequest): Promise<ConflictResolveResultDto>;
  unityGetView(id: string, path: string, staged: boolean): Promise<UnityViewDto>;
  unityGetNode(
    id: string,
    path: string,
    staged: boolean,
    nodeId: string,
  ): Promise<UnityNodeDetailDto | null>;
  unityIndexScripts(id: string): Promise<UnityScriptIndexDto>;
  logGetPage(id: string, skip: number): Promise<readonly CommitSummaryDto[]>;
  commitGetFiles(id: string, oid: string): Promise<readonly CommitFileChangeDto[]>;
  commitGetDiff(id: string, oid: string, path: string): Promise<FileDiffDto | null>;
  branchList(id: string): readonly BranchDto[];
  branchSwitch(id: string, branchName: string): Promise<BranchSwitchResultDto>;
  branchCreate(id: string, req: BranchCreateRequest): Promise<BranchCreateResultDto>;
  branchMerge(id: string, branchName: string, confirmed?: boolean): Promise<BranchMergeResultDto>;
  stashList(id: string): Promise<readonly StashEntryDto[]>;
  stashSave(id: string, message: string): Promise<StashResultDto>;
  stashApply(id: string, req: StashApplyRequest): Promise<StashResultDto>;
  stashDrop(id: string, stash: StashRefDto, confirmed?: boolean): Promise<StashResultDto>;
  stashGetFiles(id: string, stash: StashRefDto): Promise<readonly CommitFileChangeDto[]>;
  stashGetDiff(id: string, stash: StashRefDto, path: string): Promise<FileDiffDto | null>;
  remoteList(id: string): readonly string[];
  remoteFetch(id: string, remote: string): Promise<RemoteResultDto>;
  remotePull(id: string): Promise<RemoteResultDto>;
  remotePush(id: string, req: PushRequest): Promise<RemoteResultDto>;
  shellOpenPath(id: string, path: string, confirmed?: boolean): Promise<void>;
  shellShowInFolder(id: string, path: string): Promise<void>;
  shellOpenTerminal(id: string): Promise<void>;
  commandLogRecent(limit: number): readonly CommandLogEntryDto[];
  /**
   * 走行中の操作を全部中止する（アプリ終了時）。
   *
   * **IPC チャネルは持たない。** renderer から「全部止める」を撃てる必要は無く、
   * 呼ぶのは index.ts の `before-quit` と本体ウィンドウの `close` だけ。
   * これを呼ばずに終了すると、クローン中の git が孤児として残り、
   * クローン先フォルダが「使用中」でエクスプローラから削除できなくなる
   * （docs/01-architecture.md 11 章 2026-09-19 追加分）。
   */
  abortAll(): void;
}

/**
 * 終了時に中止するための、最後に作られたサービス。
 *
 * register.ts は `createService()` の結果を外へ出さない（並行編集中で触れない）ので、
 * index.ts がサービスへ届く経路がここしか無い。main プロセスが作るサービスは 1 つだけなので、
 * 「最後の 1 つ」を覚えておけば足りる（handlers/update.ts が register.ts を迂回しているのと同じ事情）。
 */
let currentService: Service | null = null;

/** アプリ終了時の後始末。サービスが無ければ何もしない。 */
export function abortAllServiceOperations(): void {
  currentService?.abortAll();
}

export function createService(deps: ServiceDeps): Service {
  const requireSessions = (): SessionManager => {
    const sessions = deps.sessions();
    if (sessions === null) {
      throw new HandlerError({
        kind: 'git-not-found',
        message: 'git が見つかりません。Git for Windows を導入してください。',
      });
    }
    return sessions;
  };

  const requireSession = (id: string): RepositorySession => {
    const session = requireSessions().get(id);
    if (session === null) {
      throw new HandlerError({ kind: 'no-session', message: 'リポジトリのタブが見つかりません。' });
    }
    return session;
  };

  const opsFor = (id: string): SessionOperations => new SessionOperations(requireSession(id));

  /**
   * 確認を main 側で強制する。
   *
   * renderer が確認せずに呼んだら 'needs-confirmation' で拒否する。
   * 「表示するだけ」ではなくここで止めるので、UI のバグで破壊操作が通ることがない
   * （docs/00-decisions.md 決定 16）。
   */
  const requireConfirmed = (action: DestructiveAction | null, confirmed: boolean | undefined): void => {
    if (action === null || confirmed === true) return;
    const spec = describeAction(action);
    throw new HandlerError({
      kind: 'needs-confirmation',
      message: spec.title,
      confirmation: { action, ...spec },
    });
  };

  /** renderer から来たパスがリポジトリ配下であることを検証する。 */
  const guardTarget = (id: string, target: OperationTargetDto): OperationTargetDto => {
    if (target.kind !== 'paths') return target;
    const root = requireSession(id).root;
    for (const path of target.paths) assertInsideRoot(root, path);
    return target;
  };

  /**
   * hunk 操作の入力検証。パスがリポジトリ配下かを確かめ、指定が空でないことを見る。
   * パッチ本体は renderer から受け取らないので、ここで見るのはパスと座標だけ。
   */
  const guardHunks = (id: string, req: HunkStageRequest): [string, readonly HunkSelection[]] => {
    const session = requireSession(id);
    assertInsideRoot(session.root, req.path);
    if (req.hunks.length === 0) {
      throw new HandlerError({ kind: 'internal', message: '対象の差分が選ばれていません。' });
    }
    for (const hunk of req.hunks) {
      if (!Number.isInteger(hunk.index) || hunk.index < 0) {
        throw new HandlerError({ kind: 'internal', message: '差分の指定が不正です。' });
      }
      /*
       * 行の指定も見る（決定 32 で追加）。
       *
       * 従来は hunk.index しか検査していなかった。Unity モードでは 1 回の選択に
       * **数百の行添字**が載るので、壊れた配列がそのまま core へ流れないようここで止める。
       * 昇順・重複なしを要求するのは `buildHunkPatch` が前提にしている形だからで、
       * lineCount 未満であることは「表示していたものと同じ hunk か」の指紋とも噛み合う。
       */
      if (hunk.lines === null) continue;
      if (!Number.isInteger(hunk.lineCount) || hunk.lineCount < 0) {
        throw new HandlerError({ kind: 'internal', message: '差分の指定が不正です。' });
      }
      let previous = -1;
      for (const line of hunk.lines) {
        if (!Number.isInteger(line) || line <= previous || line >= hunk.lineCount) {
          throw new HandlerError({ kind: 'internal', message: '差分の行指定が不正です。' });
        }
        previous = line;
      }
    }
    return [req.path, req.hunks];
  };

  /**
   * 採用（conflictResolve）の入力検証。
   *
   * **この操作だけは作業ツリーのファイルを直接書く**ので、他より厳しく見る:
   *  1. パスがリポジトリ配下（文字列）
   *  2. **実体パスもリポジトリ配下**（ジャンクション越えの禁止。shell 系 API と同じ理由）
   *  3. **status のスナップショットで未マージと報告されているファイルだけ**
   *  4. 座標が非負整数、採り方が 4 種のいずれか
   *
   * 3 が要。これが無いと、renderer のバグや細工で**リポジトリ内の任意のファイル**を
   * 書き換えられてしまう（git 経由の操作と違い、git 自身の検証が働かないため）。
   */
  const guardConflict = async (
    id: string,
    req: ConflictResolveRequest,
  ): Promise<[string, ConflictSelection, ConflictChoice]> => {
    const session = requireSession(id);
    assertInsideRoot(session.root, req.path);
    await assertRealPathInsideRoot(session.root, join(session.root, req.path));
    requireUnmerged(id, req.path);

    const s = req.section;
    const numbers = [s.index, s.startLine, s.endLine, s.ourCount, s.theirCount];
    if (numbers.some((n) => !Number.isInteger(n) || n < 0) || s.endLine <= s.startLine) {
      throw new HandlerError({ kind: 'internal', message: 'コンフリクトの指定が不正です。' });
    }
    if (!CONFLICT_CHOICES.has(req.choice)) {
      throw new HandlerError({ kind: 'internal', message: 'コンフリクトの採り方が不正です。' });
    }
    return [req.path, s, req.choice];
  };

  /**
   * そのパスが status のスナップショットで未マージと報告されているか。
   *
   * 表示（conflictGet）にも掛ける。**画面がマーカー表示に切り替わる条件と、main が
   * 読み書きを許す条件を同じスナップショットから取る**ことで、両者がずれない。
   */
  const requireUnmerged = (id: string, path: string): void => {
    const entry = requireSession(id).snapshot?.entries.find((e) => e.path === path);
    if (entry?.kind !== 'unmerged') {
      throw new HandlerError({
        kind: 'internal',
        message: 'このファイルは未マージではありません。一覧を更新してください。',
      });
    }
  };

  /**
   * renderer が送ってきたリモート名／ブランチ名を、main が持っている一覧と突き合わせる。
   *
   * パスに assertInsideRoot を通すのと同じ趣旨。git の引数は配列で渡すので
   * シェル解釈の事故は起きないが、**renderer が名前を自由に決められる状態にしない**
   * （renderer は信頼できない入力を表示する層でもある。docs/01-architecture.md 10 章）。
   */
  /**
   * `-` 始まりの名前を拒否する（3-A / 3-B）。
   *
   * `.git/config` の `[remote "--upload-pack=..."]` のように、悪意あるリポジトリの設定は
   * git のリファレンス名検証を通らない文字列をリモート名・ブランチ名にできる。
   * 一覧照合（knownRemote 等）だけでは「悪意あるリポジトリが作った一覧に載っている」ことしか
   * 保証しないので、**一覧照合と先頭 `-` 拒否の二重防御**にする（git 層の `--` 区切りとも多重化）。
   */
  const rejectLeadingDash = (label: string, value: string): void => {
    if (value.startsWith('-')) {
      throw new HandlerError({ kind: 'internal', message: label + '「' + value + '」は使用できません。' });
    }
  };

  const knownRemote = (id: string, remote: string): string => {
    rejectLeadingDash('リモート名', remote);
    const session = requireSession(id);
    if (!session.remotes.includes(remote)) {
      throw new HandlerError({ kind: 'internal', message: 'リモート「' + remote + '」がありません。' });
    }
    return remote;
  };

  const knownLocalBranch = (id: string, branch: string): string => {
    rejectLeadingDash('ブランチ名', branch);
    const session = requireSession(id);
    const found = session.branches.some((b) => !b.isRemote && b.shortName === branch);
    if (!found) {
      throw new HandlerError({ kind: 'internal', message: 'ブランチ「' + branch + '」がありません。' });
    }
    return branch;
  };

  /**
   * `branchSwitch` の対象を決める。renderer は**一覧に出ている名前そのまま**を渡す
   * （ローカルなら `feature/x`、リモートなら `origin/feature/x`）。
   *
   * リモートを渡されたときの行き先は 2 通りある:
   *  - 同じ名前（リモート名を除いた部分）のローカル枝が既にある → #12 でそこへ切り替える。
   *    `#47`（`switch --track`）は `a branch named '<name>' already exists` で失敗するため（実測）。
   *    **上流の内容は取り込まない**。取り込みたければプル（#23）かマージ（#35）を使う
   *  - 無い → #47 で取り出す。新しいローカル枝ができるので、呼び出し側は一覧も取り直す
   *
   * 照合は knownLocalBranch と同じく**一覧との突き合わせ**（3-B）。DWIM 任せ
   * （リモート名を落とした名前を `switch` に渡す）をやめたので、同名のブランチを持つ
   * リモートが 2 つあっても曖昧にならない。
   */
  const planSwitch = (
    id: string,
    branch: string,
  ): { readonly kind: 'local'; readonly name: string } | { readonly kind: 'track'; readonly name: string } => {
    rejectLeadingDash('ブランチ名', branch);
    const session = requireSession(id);
    const isLocal = (name: string): boolean =>
      session.branches.some((b) => !b.isRemote && b.shortName === name);

    if (isLocal(branch)) return { kind: 'local', name: branch };

    const remote = session.branches.find((b) => b.isRemote && b.shortName === branch);
    if (remote !== undefined) {
      // git が --track で付ける名前と同じ決め方（リモート名を 1 段だけ落とす）
      const slash = branch.indexOf('/');
      const localName = slash === -1 ? branch : branch.slice(slash + 1);
      return isLocal(localName) ? { kind: 'local', name: localName } : { kind: 'track', name: branch };
    }

    throw new HandlerError({ kind: 'internal', message: 'ブランチ「' + branch + '」がありません。' });
  };

  /**
   * renderer が送ってきたコミット id を検証する。
   *
   * `knownRemote` / `knownLocalBranch` と同じ趣旨だが、コミットは一覧を持たない
   * （ページングで渡した分しか main は知らない）ので、**形で縛る**。
   * 16 進 4〜64 文字だけを通せば、`HEAD~3` や `--upload-pack=...` のような
   * 「rev として解釈される任意の文字列」を git に渡す口が塞がる。
   */
  const validOid = (oid: string): string => {
    if (!/^[0-9a-f]{4,64}$/i.test(oid)) {
      throw new HandlerError({ kind: 'internal', message: 'コミットの指定が不正です。' });
    }
    return oid;
  };

  /**
   * renderer が送ってきた stash の指定を検証する（決定 31）。
   *
   * 番号は `stash@{n}` としてそのまま git へ渡り、oid は `diff` の 2 点指定に入る。
   * `validOid` と同じ「形で縛る」やり方で、`HEAD~3` のような任意の rev を通さない。
   * **番号と oid が食い違っていないか**（別の stash を指していないか）は core が
   * #28 を取り直して照合する——ここで見られるのは形だけで、
   * 一覧との一致は git を 1 回打たないと分からないため。
   */
  const validStash = (stash: StashRefDto): StashSelection => {
    if (!Number.isSafeInteger(stash.index) || stash.index < 0 || stash.index > 100000) {
      throw new HandlerError({ kind: 'internal', message: 'stash の指定が不正です。' });
    }
    return { index: stash.index, oid: validOid(stash.oid) };
  };

  /**
   * `stash push --staged`（#27）が打てる git か（決定 31）。
   *
   * **renderer の出し分けに任せない。** ボタンを消すのは親切のためで、
   * 止めるのはここ（決定 16 の確認を main が強制しているのと同じ考え方）。
   */
  const requireStagedStash = (): void => {
    if (supportsStagedStash(deps.gitVersion()?.version ?? null)) return;
    throw new HandlerError({
      kind: 'git-failed',
      message:
        'この git では Stash 保存モードを使えません（git 2.35 以降が必要です）。' +
        'ステージした差分だけを退避する git stash push --staged が無いためです。',
      detail: deps.gitVersion()?.version.raw ?? null,
    });
  };

  /** stash の DTO への写し替え。git 層の StashEntry をそのままワイヤへ出さない。 */
  const toStashDto = (entry: {
    readonly index: number;
    readonly ref: string;
    readonly oid: string;
    readonly parents: readonly string[];
    readonly authoredAt: string;
    readonly message: string;
  }): StashEntryDto => ({
    index: entry.index,
    ref: entry.ref,
    oid: entry.oid,
    shortOid: entry.oid.slice(0, 7),
    authoredAt: entry.authoredAt,
    message: entry.message,
    // 親 2 つ＝ HEAD と index コミット＝このアプリが作った --staged の stash
    staged: entry.parents.length === 2,
  });

  /** renderer 由来の相対パスを検証してから絶対パスへ直す（規約: git に渡す前に必ず検証）。 */
  const resolveInsideRoot = (id: string, path: string): string => {
    const session = requireSession(id);
    assertInsideRoot(session.root, path);
    return join(session.root, path);
  };

  /**
   * `shell.openPath` / `shell.showItemInFolder` の直前だけに使う、実体パスでの再検証（Medium 1）。
   *
   * `resolveInsideRoot` の文字列検証だけでは、ワークツリー内のジャンクション（Windows では
   * 無権限で作成できる）越しにリポジトリ外の実ファイルを指されても素通りしてしまう。
   * OS のファイルシステムをそのまま辿る shell 系 API の直前でだけ `fs.realpath` を通し、
   * 実体がリポジトリルート配下かを改めて確かめる。git 本体（pathspec 経由）はこの影響を
   * 受けにくいので、他の操作には適用しない。
   */
  const resolveShellTarget = async (id: string, path: string): Promise<string> => {
    const session = requireSession(id);
    const absolute = resolveInsideRoot(id, path);
    return assertRealPathInsideRoot(session.root, absolute);
  };

  const stateOf = (session: RepositorySession): SessionStateDto => ({
    id: session.id,
    statusSeq: session.statusSeq,
    head: session.snapshot?.head ?? null,
    counts: session.getStatusSummary().counts,
  });

  /**
   * タブを 1 つ立てる。
   *
   * `load` が false なら対応表 #1（ルート解決）だけで返る。UI はこちらを使い、
   * 一覧の取得は別の呼び出し（sessionLoad）に分ける。**タブが立って
   * アクティブになってから git が走らないと、実行中の表示がどのタブのものか
   * 決まらず、コマンドバーに何も出ないまま固まって見えるため**（決定 26）。
   *
   * どちらの入口でも、開いたリポジトリは設定に残す（次回起動で復元される）。
   */
  /** 開いたリポジトリを設定に残し（次回起動で復元される）、DTO にして返す。 */
  const rememberOpened = async (sessions: SessionManager, session: RepositorySession): Promise<SessionDto> => {
    await deps.updateSettings({ openRepositories: sessions.list().map((s) => s.root) });
    return { id: session.id, root: session.root, displayName: displayNameOf(session.root) };
  };

  /**
   * まだセッション id が無い操作（タブを立てる／クローン）の中止口をまとめる鍵。
   * セッション id とは衝突しない（id は UUID）。
   */
  const OPENING = '@opening';

  const addSession = async (root: string, load: boolean): Promise<SessionDto> => {
    const sessions = requireSessions();
    try {
      const session = await withSignal(OPENING, (signal) =>
        load ? sessions.open(root, signal) : sessions.create(root, signal),
      );
      return await rememberOpened(sessions, session);
    } catch (err) {
      throw asHandlerError(err);
    }
  };

  /** 進捗の opId の連番。クローンは同時に 1 本だけだが、遅れて届いた通知の出所は区別しておく。 */
  let cloneSeq = 0;
  /** 実行中のクローンの中止口。null なら実行中でない（同時に 1 本だけ）。 */
  let cloneAbort: AbortController | null = null;

  /**
   * 走行中のハンドラの中止口（セッション id ごと）。
   *
   * `operations.ts` / `repositorySession.ts` / `sessionManager.ts` は既に全メソッドが
   * `signal?: AbortSignal` を受けて `context(signal)` へ渡している。欠けていたのは
   * **呼び出し側だけ**で、そのため実際には中断もタイムアウトもできていなかった
   * （docs/01-architecture.md 6 章 2026-09-19 改定）。
   *
   * セッションに属さない操作（クローン）は cloneAbort が別に持つ。
   */
  const inFlight = new Map<string, Set<AbortController>>();

  /** 1 回の操作に AbortController を 1 つ与え、終わったら必ず外す。 */
  const withSignal = async <T>(id: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    let bucket = inFlight.get(id);
    if (bucket === undefined) {
      bucket = new Set();
      inFlight.set(id, bucket);
    }
    bucket.add(controller);
    try {
      return await run(controller.signal);
    } finally {
      bucket.delete(controller);
      if (bucket.size === 0) inFlight.delete(id);
    }
  };

  /** そのタブの走行中を全部止める。タブを閉じたときに呼ぶ。 */
  const abortSession = (id: string): void => {
    const bucket = inFlight.get(id);
    if (bucket === undefined) return;
    inFlight.delete(id);
    for (const controller of bucket) controller.abort();
  };

  /** 全部止める（アプリ終了時）。クローンも含む。 */
  const abortEverything = (): void => {
    cloneAbort?.abort();
    const buckets = [...inFlight.values()];
    inFlight.clear();
    for (const bucket of buckets) {
      for (const controller of bucket) controller.abort();
    }
  };

  /**
   * 壊れた `.git`（git が親リポジトリを返す）を UI に出せるエラーへ写す。
   *
   * core は ipc の型を知らないので、名前で判別して HandlerError に載せ替える
   * （errors.ts の toDto と同じやり方）。素通しすると kind が 'internal' になり、
   * 「内部エラーが発生しました。」としか出ない。
   */
  const asHandlerError = (err: unknown): unknown => {
    if (err instanceof Error && err.name === 'BrokenRepositoryError') {
      return new HandlerError({
        kind: 'not-a-repository',
        message: 'このフォルダの .git は読めません。壊れている可能性があります。',
        detail: err.message,
      });
    }
    return err;
  };

  /**
   * クローンの入力検証（対応表 #37）。knownRemote と同じ趣旨で、renderer の値を git へ素通しにしない。
   *
   * URL は git に `--` の後ろで渡すのでオプションにはならないが、`-` 始まりはここでも弾いて二重に塞ぐ。
   * フォルダ名は 1 階層に限る（区切りを許すと保存先の外へ作れてしまう）。
   * 保存先が空かどうかは見ない。それは git 自身が判定してエラーにする（アプリ都合の事前チェックを挟まない）。
   */
  const guardClone = async (req: CloneRequest): Promise<CloneRequest> => {
    const reject = (message: string): never => {
      throw new HandlerError({ kind: 'internal', message });
    };
    const url = req.url.trim();
    const parentDir = req.parentDir.trim();
    const name = req.name.trim();

    if (url.length === 0) reject('URL を入力してください。');
    if (url.startsWith('-') || hasControlChar(url)) reject('URL が正しくありません。');
    if (name.length === 0) reject('フォルダ名を入力してください。');
    if (name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name) || hasControlChar(name) || /[. ]$/.test(name)) {
      reject('フォルダ名に使えない文字が含まれています。');
    }
    if (!isAbsolute(parentDir)) reject('保存先フォルダは絶対パスで指定してください。');
    const info = await stat(parentDir).catch(() => null);
    if (info === null || !info.isDirectory()) reject('保存先フォルダが見つかりません。');

    const mode = req.mode === 'shallow' || req.mode === 'large' ? req.mode : 'normal';

    // SSH 鍵は任意。指定するなら絶対パス（理由は assertAbsolutePathSetting と同じ）
    const sshKeyPath = req.sshKeyPath ?? null;
    assertAbsolutePathSetting('SSH 秘密鍵のパス', sshKeyPath);

    return { url, parentDir, name, mode, sshKeyPath };
  };

  /**
   * そのリポジトリに使う SSH 鍵を設定へ書く（決定 13 の 2026-09-19 改定 2）。
   * null なら登録を消す。**リポジトリ別の辞書なので、他のリポジトリの登録は触らない。**
   */
  const rememberSshKey = async (root: string, keyPath: string | null): Promise<void> => {
    const current = deps.settings().sshKeyPaths;
    if ((current[root] ?? null) === keyPath) return;

    const next: Record<string, string> = { ...current };
    if (keyPath === null) delete next[root];
    else next[root] = keyPath;
    await deps.updateSettings({ sshKeyPaths: next });
  };

  const service: Service = {
    appGetInfo: () => deps.appInfo(),

    appGetEnvironment: () => {
      const git = deps.git();
      const version = deps.gitVersion();
      return {
        gitPath: git?.gitPath ?? null,
        gitSource: git?.source ?? null,
        gitVersion: version?.version.raw ?? null,
        sshPath: deps.sshPath(),
        // 決定 31: 古い git では Stash 保存モードの保存だけを止める
        supportsStagedStash: supportsStagedStash(version?.version ?? null),
        warning:
          git === null
            ? 'git が見つかりませんでした。Git for Windows を導入するか、設定で git.exe のパスを指定してください。'
            : (version?.warning ?? null),
      };
    },

    settingsGet: () => deps.settings(),

    settingsUpdate: async (patch) => {
      assertAbsolutePathSetting('git.exe のパス', patch.gitPath);
      /*
       * SSH 鍵はリポジトリ別の辞書。UI からは sshSetKey（1 リポジトリずつ）を通るので
       * ここに来るのは想定外だが、来たならキーも値も絶対パスであることを見る。
       */
      for (const [root, keyPath] of Object.entries(patch.sshKeyPaths ?? {})) {
        assertAbsolutePathSetting('リポジトリのパス', root);
        assertAbsolutePathSetting('SSH 秘密鍵のパス', keyPath);
      }
      const before = deps.settings().gitPath;
      const wasUnity = deps.settings().viewMode === 'unity';
      const updated = await deps.updateSettings(patch);
      if (updated.gitPath !== before) await deps.reloadGit();
      /*
       * Unity モードを離れたら、抱えている Prefab / シーンを手放す（決定 32 / F-1）。
       * 100MB 級のシーンを 2 側ぶん掴んだまま他のモードで作業されると、
       * 見ていないもののためにヒープを食い続けることになる。
       * 専用の IPC を増やさずに済むよう、モードが替わるこの 1 か所で拾う。
       */
      if (wasUnity && updated.viewMode !== 'unity') {
        for (const session of deps.sessions()?.all() ?? []) session.releaseUnityView();
      }
      return updated;
    },

    dialogPickFile: (kind) => deps.pickFile(kind),

    // async にしてあるのは、タブが無いときに**同期例外ではなく reject** で返すため
    // （Service の型は Promise を返す約束なので、呼び出し側は catch ではなく .catch を書く）
    gitConfigGetIdentity: async (id) => requireSession(id).getCommitIdentity(),

    /*
     * 対応表 #44。値の検証は**ここが実質の唯一の防壁**（git config の値は位置引数で、
     * fetch / push のような `--` による守りが効かない。docs/02-git-command-map.md #42〜#44）。
     * 検証に落ちたら git を 1 本も起動せずに返す。
     *
     * 空文字は拒否する。ローカルの設定を消すと全体設定の値に黙って戻るためで、
     * 削除したい人にはターミナルのコマンドを案内する（決定 13 の追記）。
     */
    gitConfigSetIdentity: async (id, req) => {
      const session = requireSession(id);
      const patch: { name?: string; email?: string } = {};

      for (const [key, label] of [
        ['name', '名前'],
        ['email', 'メールアドレス'],
      ] as const) {
        const raw = req[key];
        if (raw === null || raw === undefined) continue;
        const checked = validateIdentityValue(raw);
        if (!checked.ok) {
          throw new HandlerError({
            kind: 'internal',
            message: describeIdentityRejection(label, checked.reason),
          });
        }
        patch[key] = checked.value;
      }

      await session.setLocalCommitIdentity(patch);
      return null;
    },

    /*
     * そのリポジトリで使う SSH 鍵（決定 13 の 2026-09-19 改定 2）。
     * 鍵の登録先はセッションのルートなので、renderer はリポジトリのパスを送らない。
     * git は動かさない——次にこのリポジトリで git を実行するときから効く。
     */
    sshSetKey: async (id, keyPath) => {
      const session = requireSession(id);
      assertAbsolutePathSetting('SSH 秘密鍵のパス', keyPath);
      await rememberSshKey(session.root, keyPath);
      return deps.settings();
    },

    sessionPickAndCreate: async () => {
      const picked = await deps.pickDirectory();
      if (picked === null) return null;
      return addSession(picked, false);
    },

    sessionLoad: async (id) => {
      const sessions = requireSessions();
      await withSignal(id, (signal) => sessions.load(id, signal));
      return null;
    },

    sessionOpen: (root) => addSession(root, true),

    clonePickDirectory: () => deps.pickDirectory(),

    /*
     * クローン（決定 9 / 対応表 #37〜#41 → #1）。
     * git の失敗・中止・git が無いことは例外にせず、結果（ヒント・生ログ）で返す。
     * 例外になるのは入力検証の違反と、二重の実行だけ（どちらも renderer の不具合でしか起きない）。
     */
    sessionCloneAndCreate: async (req) => {
      const valid = await guardClone(req);
      if (cloneAbort !== null) throw new HandlerError({ kind: 'internal', message: 'クローンを実行中です。' });

      const sessions = deps.sessions();
      if (sessions === null) {
        return {
          result: 'failed',
          cancelled: false,
          session: null,
          target: join(valid.parentDir, valid.name),
          stages: [],
          hints: [gitNotFoundHint()],
          followUps: [],
          log: '',
        };
      }

      cloneSeq += 1;
      const opId = 'clone:' + String(cloneSeq);
      const controller = new AbortController();
      cloneAbort = controller;
      const throttle = createProgressThrottle<CloneStage[]>(
        (stages) => deps.notifyCloneProgress({ opId, stages }),
        CLONE_PROGRESS_INTERVAL_MS,
      );
      try {
        const outcome = await sessions.clone(valid, (stages, urgent) => throttle.push(stages, urgent), controller.signal);
        const session = outcome.session === null ? null : await rememberOpened(sessions, outcome.session);
        /*
         * クローンに使った鍵を、そのリポジトリの設定として引き継ぐ（決定 9 の追記）。
         * タブが立った（= リポジトリができた）ときだけ。失敗したクローンの行き先に
         * 鍵の登録だけ残っても意味が無い。
         */
        const usedKey = valid.sshKeyPath ?? null;
        if (outcome.session !== null && usedKey !== null) {
          await rememberSshKey(outcome.session.root, usedKey);
        }
        return {
          result: outcome.result,
          cancelled: outcome.cancelled,
          session,
          target: outcome.target,
          stages: outcome.stages,
          hints: outcome.hints,
          followUps: outcome.followUps,
          log: outcome.log,
        };
      } finally {
        // 結果に最終の段階表が載るので、溜まった途中の値は捨てる
        throttle.dispose();
        cloneAbort = null;
      }
    },

    cloneCancel: () => {
      cloneAbort?.abort();
      return null;
    },

    abortAll: abortEverything,

    sessionList: () => {
      const sessions = deps.sessions();
      if (sessions === null) return { sessions: [], activeId: null };
      return { sessions: sessions.list(), activeId: sessions.activeId };
    },

    sessionActivate: async (id) => {
      const sessions = requireSessions();
      // 復元直後の未読み込みタブに切り替えたときだけ、その 1 つを読み込む
      await withSignal(id, (signal) => sessions.activate(id, signal));
      return null;
    },

    sessionClose: async (id) => {
      const sessions = requireSessions();
      /*
       * **閉じる前に走行中を止める。** タブが消えた後も git が走り続けると、
       * 誰も結果を受け取らないまま孤児として残る（決定 26 の実行ログにも出口が無い）。
       */
      abortSession(id);
      sessions.close(id);
      await deps.updateSettings({ openRepositories: sessions.list().map((s) => s.root) });
      return null;
    },

    sessionRefresh: async (id, scope) => {
      const sessions = requireSessions();
      await withSignal(id, (signal) =>
        scope === 'full' ? sessions.requestFullRefresh(id, signal) : sessions.requestStatusRefresh(id, signal),
      );
      return stateOf(requireSession(id));
    },

    sessionReorder: async (order) => {
      const sessions = requireSessions();
      sessions.reorder(order);
      await deps.updateSettings({ openRepositories: sessions.list().map((s) => s.root) });
      return null;
    },

    statusGetSummary: (id) => {
      const session = requireSession(id);
      const summary = session.getStatusSummary();
      return {
        seq: session.statusSeq,
        counts: summary.counts,
        head: session.snapshot?.head ?? null,
        hasSnapshot: summary.hasSnapshot,
      };
    },

    statusGetPage: (id, req) => {
      const session = requireSession(id);
      const limit = Math.min(Math.max(0, req.limit), MAX_PAGE_LIMIT);
      const page = session.getStatusPage(req.offset, limit, req.filter);
      return {
        seq: session.statusSeq,
        offset: page.offset,
        entries: page.entries,
        filteredTotal: page.filteredTotal,
      };
    },

    stage: async (id, target) => {
      const ops = opsFor(id);
      const guarded = guardTarget(id, target);
      return withSignal(id, (signal) => ops.stage(guarded, signal));
    },

    unstage: async (id, target) => {
      const ops = opsFor(id);
      const guarded = guardTarget(id, target);
      return withSignal(id, (signal) => ops.unstage(guarded, signal));
    },

    discard: async (id, target, confirmed) => {
      const ops = opsFor(id);
      const guarded = guardTarget(id, target);
      const hasStaged = ops.targetHasStaged(guarded);
      requireConfirmed(SessionOperations.confirmationFor('discard', { hasStaged }), confirmed);
      return withSignal(id, (signal) => ops.discard(guarded, signal));
    },

    deleteUntracked: async (id, target, confirmed) => {
      requireConfirmed(SessionOperations.confirmationFor('deleteUntracked'), confirmed);
      const ops = opsFor(id);
      const guarded = guardTarget(id, target);
      return withSignal(id, (signal) => ops.deleteUntracked(guarded, signal));
    },

    commit: async (id, req, confirmed) => {
      if (req.message.trim().length === 0) {
        throw new HandlerError({ kind: 'internal', message: 'コミットメッセージが空です。' });
      }
      requireConfirmed(SessionOperations.confirmationFor('commit', { amend: req.amend }), confirmed);
      const ops = opsFor(id);
      return withSignal(id, (signal) => ops.commit(req.message, { amend: req.amend }, signal));
    },

    stageHunks: async (id, req) => {
      const ops = opsFor(id);
      const [path, hunks] = guardHunks(id, req);
      return withSignal(id, (signal) => ops.stageHunks(path, hunks, signal));
    },

    unstageHunks: async (id, req) => {
      const ops = opsFor(id);
      const [path, hunks] = guardHunks(id, req);
      return withSignal(id, (signal) => ops.unstageHunks(path, hunks, signal));
    },

    diffGet: async (id, path, staged) => {
      const session = requireSession(id);
      assertInsideRoot(session.root, path);
      const diff = await withSignal(id, (signal) => session.getDiff(path, staged, signal));
      if (diff === null) return null;
      // preamble は DTO に載せない（git の内部形式を renderer へ漏らさない）。
      // 代わりに「hunk 単位で操作できるか」だけを導出して渡す
      return {
        path: diff.path,
        oldPath: diff.oldPath,
        binary: diff.binary,
        hunks: diff.hunks,
        truncated: diff.truncated,
        hunkStageable: canBuildPatch(diff) === null,
      };
    },

    /*
     * 未マージファイルのマーカー表示。git は動かない（作業ツリーのファイルを読むだけ）。
     * モデルと DTO が同形なので、diff と違って写し替えるものが無い。
     */
    conflictGet: async (id, path) => {
      const session = requireSession(id);
      assertInsideRoot(session.root, path);
      requireUnmerged(id, path);
      return withSignal(id, (signal) => session.getConflict(path, signal));
    },

    conflictResolve: async (id, req) => {
      const ops = opsFor(id);
      const [path, section, choice] = await guardConflict(id, req);
      return withSignal(id, (signal) => ops.resolveConflict(path, section, choice, signal));
    },

    /*
     * Unity モードのヒエラルキー（決定 32）。
     *
     * **ヒエラルキーだけを返す。** プロパティの表は unityGetNode で 1 ノードずつ取る。
     * 全ノードの全行を 1 回で送ると、構造化クローンは同期なので画面が数秒止まる。
     */
    unityGetView: async (id, path, staged) => {
      const session = requireSession(id);
      assertInsideRoot(session.root, path);
      const view = await withSignal(id, (signal) => session.getUnityView(path, staged, signal));
      return {
        path: view.path,
        staged: view.staged,
        format: view.format,
        nodes: view.nodes,
        stageable: view.stageable,
        refusal: view.refusal,
        changedNodeCount: view.nodes.reduce((n, node) => (node.mark === 'same' ? n : n + 1), 0),
      };
    },

    /*
     * 選んだ 1 ノードのプロパティ表。ここで初めて本体のパースとフローの分解が走る。
     *
     * ステージの座標も**ここで計算して載せる**ので、renderer は既存の
     * stageHunks / unstageHunks にそのまま流せる。新しいステージ用の口は増やさない
     * （パッチ本体を renderer から受け取らない決定はそのまま保たれる）。
     */
    unityGetNode: async (id, path, staged, nodeId) => {
      const session = requireSession(id);
      assertInsideRoot(session.root, path);
      const view = await withSignal(id, (signal) => session.getUnityView(path, staged, signal));
      const rows = rowsFor(view, nodeId);
      if (rows.length === 0) return null;
      return {
        nodeId,
        rows: rows.map((entry) => ({
          key: entry.row.key,
          before: entry.row.before,
          after: entry.row.after,
          state: entry.row.state,
          selection: entry.selection,
          alsoStages: entry.alsoStages,
        })),
        selection: selectionForNode(view, nodeId),
      };
    },

    /*
     * guid -> スクリプト名 / Prefab 名の索引（要件 11）。**git は 0 プロセス。**
     *
     * 利用者がペインのボタンを押したときだけ来る。数千の `.meta` を読むので、
     * ファイルを選ぶたびに自動で走らせてよい処理ではない（CLAUDE.md「ファイル I/O が非常に遅い」）。
     */
    unityIndexScripts: async (id) => {
      const session = requireSession(id);
      const index = await withSignal(id, (signal) => session.indexUnityScripts(signal));
      return { resolved: index.names.size };
    },

    logGetPage: async (id, skip) => requireSession(id).getLogPage(Math.max(0, skip)),

    commitGetFiles: async (id, oid) => requireSession(id).getCommitFiles(validOid(oid)),

    commitGetDiff: async (id, oid, path) => {
      const session = requireSession(id);
      assertInsideRoot(session.root, path);
      const diff = await session.getCommitDiff(validOid(oid), path);
      if (diff === null) return null;
      // 作業ツリーの diff と同じ DTO を返すが、過去のコミットからはステージできないので
      // hunkStageable は必ず false。canBuildPatch を呼ぶまでもない。
      return {
        path: diff.path,
        oldPath: diff.oldPath,
        binary: diff.binary,
        hunks: diff.hunks,
        truncated: diff.truncated,
        hunkStageable: false,
      };
    },

    branchList: (id) => requireSession(id).branches,

    branchSwitch: async (id, branchName) => {
      const plan = planSwitch(id, branchName);
      const ops = opsFor(id);
      return plan.kind === 'track' ? ops.switchToRemoteBranch(plan.name) : ops.switchBranch(plan.name);
    },

    branchCreate: async (id, req) => {
      const name = req.name.trim();
      const startPoint = req.startPoint.trim();
      if (name.length === 0) {
        throw new HandlerError({ kind: 'internal', message: '新しいブランチ名を入力してください。' });
      }
      if (startPoint.length === 0) {
        throw new HandlerError({ kind: 'internal', message: 'ブランチ元を入力してください。' });
      }
      // renderer が自由に打てる 2 つの文字列。knownRemote 等と違い一覧照合はできない
      // （まだ存在しないブランチ名を作る操作のため）ので、先頭 `-` だけ形で縛る。
      rejectLeadingDash('新しいブランチ名', name);
      rejectLeadingDash('ブランチ元', startPoint);
      return opsFor(id).createBranch(name, startPoint);
    },

    branchMerge: async (id, branchName, confirmed) => {
      const name = branchName.trim();
      if (name.length === 0) {
        throw new HandlerError({ kind: 'internal', message: 'マージするブランチを指定してください。' });
      }
      // マージの右クリックメニューはローカルブランチにしか出さない（BranchPane.svelte）ので
      // knownLocalBranch で一覧照合する。remotePush と同じ趣旨（3-B）。
      const known = knownLocalBranch(id, name);
      const ops = opsFor(id);
      requireConfirmed(SessionOperations.confirmationFor('merge'), confirmed);
      return ops.mergeBranch(known);
    },

    /*
     * リモート操作（対応表 #22〜#25）。確認は要らない（決定 16）。
     * 引数は必ず main 側の一覧と照合してから git へ渡す。
     */
    /*
     * stash（決定 31 / 対応表 #27〜#31、#45、#46）。
     *
     * 読み取りは oid、書き込みは番号（core が #28 で照合してから `stash@{n}` を組む）。
     * 確認が要るのは破棄だけ（決定 16）。
     */
    stashList: async (id) => {
      const session = requireSession(id);
      const stashes = await withSignal(id, (signal) => session.listStashes(signal));
      return stashes.map(toStashDto);
    },

    stashSave: async (id, message) => {
      requireStagedStash();
      const checked = validateStashMessage(message);
      if (!checked.ok) {
        throw new HandlerError({ kind: 'internal', message: describeStashMessageRejection(checked.reason) });
      }
      const ops = opsFor(id);
      const outcome = await withSignal(id, (signal) => ops.saveStash(checked.value, signal));
      return { statusSeq: outcome.statusSeq, stashes: outcome.stashes.map(toStashDto) };
    },

    stashApply: async (id, req) => {
      const selection = validStash(req.stash);
      const ops = opsFor(id);
      const outcome = await withSignal(id, (signal) =>
        ops.applyStash(selection, req.drop === true, signal),
      );
      return { statusSeq: outcome.statusSeq, stashes: outcome.stashes.map(toStashDto) };
    },

    stashDrop: async (id, stash, confirmed) => {
      const selection = validStash(stash);
      requireConfirmed(SessionOperations.confirmationFor('stashDrop'), confirmed);
      const ops = opsFor(id);
      const outcome = await withSignal(id, (signal) => ops.dropStash(selection, signal));
      return { statusSeq: outcome.statusSeq, stashes: outcome.stashes.map(toStashDto) };
    },

    stashGetFiles: async (id, stash) => {
      const session = requireSession(id);
      const selection = validStash(stash);
      return withSignal(id, (signal) => session.getStashFiles(selection.oid, signal));
    },

    /*
     * #46。外部で `-u` 付きに作られた stash（親が 3 つ）では、未追跡としてだけ
     * 入っているファイルが `<oid>^ <oid>` の diff に現れない（実測）。そのときだけ
     * 第 3 親を相手に打ち直す。**このアプリが作った stash では 2 回目は起きない。**
     */
    stashGetDiff: async (id, stash, path) => {
      const session = requireSession(id);
      assertInsideRoot(session.root, path);
      const selection = validStash(stash);

      let diff = await withSignal(id, (signal) =>
        session.getStashDiff(selection.oid, path, false, signal),
      );
      if (diff === null) {
        const entry = (await withSignal(id, (signal) => session.listStashes(signal))).find(
          (s) => s.oid === selection.oid,
        );
        if (entry !== undefined && entry.parents.length >= 3) {
          diff = await withSignal(id, (signal) =>
            session.getStashDiff(selection.oid, path, true, signal),
          );
        }
      }
      if (diff === null) return null;

      // stash から直接ステージすることはできないので hunkStageable は必ず false
      return {
        path: diff.path,
        oldPath: diff.oldPath,
        binary: diff.binary,
        hunks: diff.hunks,
        truncated: diff.truncated,
        hunkStageable: false,
      };
    },

    remoteList: (id) => requireSession(id).remotes,

    // async にしてあるのは、名前の照合で投げる例外も必ず reject として届けるため
    remoteFetch: async (id, remote) => opsFor(id).fetch(knownRemote(id, remote)),

    remotePull: async (id) => opsFor(id).pull(),

    remotePush: async (id, req) =>
      opsFor(id).push(knownRemote(id, req.remote), knownLocalBranch(id, req.branch), req.setUpstream),

    /**
     * リポジトリをターミナルで開く（決定 26）。
     * renderer からはセッション id しか来ない。開く場所も実行ファイルもここで決める。
     */
    shellOpenTerminal: async (id) => {
      const session = requireSession(id);
      const launch = await deps.resolveTerminal(session.root);
      if (launch === null) {
        throw new HandlerError({
          kind: 'git-not-found',
          message: 'git を実行できるターミナルが見つかりません。',
          detail: 'git.exe が PATH に無く、Git Bash も見つかりませんでした。',
        });
      }
      deps.launchTerminal(launch, session.root);
    },

    shellOpenPath: async (id, path, confirmed) => {
      const absolute = await resolveShellTarget(id, path);
      /*
       * 実行されうる拡張子（脆弱性診断 §5）だけ確認を強制する。resolveShellTarget の
       * 実体パス検証（Medium 1）の**後**に見るのは、ジャンクション越しに実体の拡張子を
       * 詐称されないようにするため（文字列上のパスではなく実体パスの basename を見る）。
       * discard 等と同じ形（HandlerError の needs-confirmation）にするが、これは
       * DestructiveAction ではない（git 操作ではないため別枠。決定 16 の例外）。
       */
      if (isExecutableFileName(basename(absolute)) && confirmed !== true) {
        throw new HandlerError({
          kind: 'needs-confirmation',
          message: OPEN_EXECUTABLE_CONFIRMATION.title,
          confirmation: OPEN_EXECUTABLE_CONFIRMATION,
        });
      }
      const failure = await deps.openPath(absolute);
      // openPath は throw せずエラー文字列を返す（ファイルが無いときなど）
      if (failure.length > 0) {
        throw new HandlerError({ kind: 'not-found', message: 'ファイルを開けませんでした。', detail: failure });
      }
    },

    shellShowInFolder: async (id, path) => {
      deps.showItemInFolder(await resolveShellTarget(id, path));
    },

    commandLogRecent: (limit) =>
      deps
        .commandLog()
        .recent(Math.min(Math.max(1, limit), 500))
        .map(toCommandLogEntryDto),
  };

  // 終了時に index.ts から届く唯一の経路（上の currentService のコメント）
  currentService = service;
  return service;
}
