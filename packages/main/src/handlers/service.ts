import {
  OPEN_EXECUTABLE_CONFIRMATION,
  SessionOperations,
  canBuildPatch,
  describeAction,
  describeIdentityRejection,
  displayNameOf,
  gitNotFoundHint,
  isExecutableFileName,
  validateIdentityValue,
  type AppSettings,
  type CloneStage,
  type CommandLog,
  type DestructiveAction,
  type GitLocation,
  type GitVersionCheck,
  type HunkSelection,
  type RepositorySession,
  type SessionManager,
  type TerminalLaunch,
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
  StatusPageDto,
  StatusPageRequest,
  StatusSummaryDto,
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
  logGetPage(id: string, skip: number): Promise<readonly CommitSummaryDto[]>;
  commitGetFiles(id: string, oid: string): Promise<readonly CommitFileChangeDto[]>;
  commitGetDiff(id: string, oid: string, path: string): Promise<FileDiffDto | null>;
  branchList(id: string): readonly BranchDto[];
  branchSwitch(id: string, branchName: string): Promise<BranchSwitchResultDto>;
  branchCreate(id: string, req: BranchCreateRequest): Promise<BranchCreateResultDto>;
  branchMerge(id: string, branchName: string, confirmed?: boolean): Promise<BranchMergeResultDto>;
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
    }
    return [req.path, req.hunks];
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
   * `branchSwitch` 専用の照合。
   *
   * renderer（BranchPane.svelte の switchArg）はリモートブランチをダブルクリックしたとき、
   * リモート名を除いた名前を渡す（git の DWIM に「ローカル追跡ブランチを新規作成して切替」を
   * 任せるため）。そのため switch の対象はローカルブランチの shortName だけでなく、
   * 「いずれかのリモートブランチの shortName からリモート名を除いた名前」も正当な入力になる。
   * knownLocalBranch のように「ローカル一覧にある名前だけ」に絞ると DWIM チェックアウトが
   * 全滅するので、ここだけ別の照合にする。
   */
  const knownSwitchTarget = (id: string, branch: string): string => {
    rejectLeadingDash('ブランチ名', branch);
    const session = requireSession(id);
    const found = session.branches.some((b) => {
      if (!b.isRemote) return b.shortName === branch;
      const slash = b.shortName.indexOf('/');
      const deprefixed = slash === -1 ? b.shortName : b.shortName.slice(slash + 1);
      return deprefixed === branch;
    });
    if (!found) {
      throw new HandlerError({ kind: 'internal', message: 'ブランチ「' + branch + '」がありません。' });
    }
    return branch;
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
    return { url, parentDir, name, mode };
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
        warning:
          git === null
            ? 'git が見つかりませんでした。Git for Windows を導入するか、設定で git.exe のパスを指定してください。'
            : (version?.warning ?? null),
      };
    },

    settingsGet: () => deps.settings(),

    settingsUpdate: async (patch) => {
      assertAbsolutePathSetting('git.exe のパス', patch.gitPath);
      assertAbsolutePathSetting('SSH 秘密鍵のパス', patch.sshKeyPath);
      const before = deps.settings().gitPath;
      const updated = await deps.updateSettings(patch);
      if (updated.gitPath !== before) await deps.reloadGit();
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

    branchSwitch: async (id, branchName) => opsFor(id).switchBranch(knownSwitchTarget(id, branchName)),

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
