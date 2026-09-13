import {
  SessionOperations,
  canBuildPatch,
  describeAction,
  displayNameOf,
  type AppSettings,
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
  CloneRequest,
  ProgressEvent,
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
  OperationResultDto,
  OperationTargetDto,
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
import { isAbsolute, join } from 'node:path';
import { assertInsideRoot } from '@feathertree/base-core';
import { HandlerError } from '../errors.js';

/** ページで一度に返す最大件数。renderer が巨大な要求を投げても抑える。 */
const MAX_PAGE_LIMIT = 1000;

/** 制御文字（改行・NUL など）を含むか。正規表現に書くと no-control-regex に掛かるので文字コードで見る。 */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
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
  /** git の進捗行を renderer へ送る（今の送り手はクローンだけ）。 */
  readonly notifyProgress: (event: ProgressEvent) => void;
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
  sessionPickAndCreate(): Promise<SessionDto | null>;
  sessionLoad(id: string): Promise<null>;
  sessionOpen(root: string): Promise<SessionDto>;
  clonePickDirectory(): Promise<string | null>;
  sessionCloneAndCreate(req: CloneRequest): Promise<SessionDto>;
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
  shellOpenPath(id: string, path: string): Promise<void>;
  shellShowInFolder(id: string, path: string): Promise<void>;
  shellOpenTerminal(id: string): Promise<void>;
  commandLogRecent(limit: number): readonly CommandLogEntryDto[];
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
  const knownRemote = (id: string, remote: string): string => {
    const session = requireSession(id);
    if (!session.remotes.includes(remote)) {
      throw new HandlerError({ kind: 'internal', message: 'リモート「' + remote + '」がありません。' });
    }
    return remote;
  };

  const knownLocalBranch = (id: string, branch: string): string => {
    const session = requireSession(id);
    const found = session.branches.some((b) => !b.isRemote && b.shortName === branch);
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

  const addSession = async (root: string, load: boolean): Promise<SessionDto> => {
    const sessions = requireSessions();
    const session = load ? await sessions.open(root) : await sessions.create(root);
    return rememberOpened(sessions, session);
  };

  /** 進捗行の opId の連番。クローンは同時に 1 つしか走らない想定だが、行の出所は区別しておく。 */
  let cloneSeq = 0;

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

    return { url, parentDir, name, shallow: req.shallow === true };
  };

  return {
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
      const before = deps.settings().gitPath;
      const updated = await deps.updateSettings(patch);
      if (updated.gitPath !== before) await deps.reloadGit();
      return updated;
    },

    sessionPickAndCreate: async () => {
      const picked = await deps.pickDirectory();
      if (picked === null) return null;
      return addSession(picked, false);
    },

    sessionLoad: async (id) => {
      await requireSessions().load(id);
      return null;
    },

    sessionOpen: (root) => addSession(root, true),

    clonePickDirectory: () => deps.pickDirectory(),

    sessionCloneAndCreate: async (req) => {
      const sessions = requireSessions();
      const valid = await guardClone(req);
      cloneSeq += 1;
      const opId = 'clone:' + String(cloneSeq);
      // セッションが立つ前なので sessionId は null（renderer はクローン中の null だけを拾う）
      const session = await sessions.clone(valid, (line) => deps.notifyProgress({ sessionId: null, opId, line }));
      return rememberOpened(sessions, session);
    },

    sessionList: () => {
      const sessions = deps.sessions();
      if (sessions === null) return { sessions: [], activeId: null };
      return { sessions: sessions.list(), activeId: sessions.activeId };
    },

    sessionActivate: async (id) => {
      // 復元直後の未読み込みタブに切り替えたときだけ、その 1 つを読み込む
      await requireSessions().activate(id);
      return null;
    },

    sessionClose: async (id) => {
      const sessions = requireSessions();
      sessions.close(id);
      await deps.updateSettings({ openRepositories: sessions.list().map((s) => s.root) });
      return null;
    },

    sessionRefresh: async (id, scope) => {
      const sessions = requireSessions();
      if (scope === 'full') await sessions.requestFullRefresh(id);
      else await sessions.requestStatusRefresh(id);
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

    stage: async (id, target) => opsFor(id).stage(guardTarget(id, target)),

    unstage: async (id, target) => opsFor(id).unstage(guardTarget(id, target)),

    discard: async (id, target, confirmed) => {
      const ops = opsFor(id);
      const guarded = guardTarget(id, target);
      const hasStaged = ops.targetHasStaged(guarded);
      requireConfirmed(SessionOperations.confirmationFor('discard', { hasStaged }), confirmed);
      return ops.discard(guarded);
    },

    deleteUntracked: async (id, target, confirmed) => {
      requireConfirmed(SessionOperations.confirmationFor('deleteUntracked'), confirmed);
      return opsFor(id).deleteUntracked(guardTarget(id, target));
    },

    commit: async (id, req, confirmed) => {
      if (req.message.trim().length === 0) {
        throw new HandlerError({ kind: 'internal', message: 'コミットメッセージが空です。' });
      }
      requireConfirmed(SessionOperations.confirmationFor('commit', { amend: req.amend }), confirmed);
      return opsFor(id).commit(req.message, { amend: req.amend });
    },

    stageHunks: async (id, req) => opsFor(id).stageHunks(...guardHunks(id, req)),

    unstageHunks: async (id, req) => opsFor(id).unstageHunks(...guardHunks(id, req)),

    diffGet: async (id, path, staged) => {
      const session = requireSession(id);
      assertInsideRoot(session.root, path);
      const diff = await session.getDiff(path, staged);
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

    branchSwitch: async (id, branchName) => opsFor(id).switchBranch(branchName),

    branchCreate: async (id, req) => {
      const name = req.name.trim();
      const startPoint = req.startPoint.trim();
      if (name.length === 0) {
        throw new HandlerError({ kind: 'internal', message: '新しいブランチ名を入力してください。' });
      }
      if (startPoint.length === 0) {
        throw new HandlerError({ kind: 'internal', message: 'ブランチ元を入力してください。' });
      }
      return opsFor(id).createBranch(name, startPoint);
    },

    branchMerge: async (id, branchName, confirmed) => {
      const name = branchName.trim();
      if (name.length === 0) {
        throw new HandlerError({ kind: 'internal', message: 'マージするブランチを指定してください。' });
      }
      const ops = opsFor(id);
      requireConfirmed(SessionOperations.confirmationFor('merge'), confirmed);
      return ops.mergeBranch(name);
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

    shellOpenPath: async (id, path) => {
      const absolute = resolveInsideRoot(id, path);
      const failure = await deps.openPath(absolute);
      // openPath は throw せずエラー文字列を返す（ファイルが無いときなど）
      if (failure.length > 0) {
        throw new HandlerError({ kind: 'not-found', message: 'ファイルを開けませんでした。', detail: failure });
      }
    },

    shellShowInFolder: async (id, path) => {
      deps.showItemInFolder(resolveInsideRoot(id, path));
    },

    commandLogRecent: (limit) => deps.commandLog().recent(Math.min(Math.max(1, limit), 500)),
  };
}
