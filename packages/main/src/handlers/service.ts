import {
  SessionOperations,
  describeAction,
  displayNameOf,
  type AppSettings,
  type CommandLog,
  type DestructiveAction,
  type GitLocation,
  type GitVersionCheck,
  type RepositorySession,
  type SessionManager,
} from '@feathertree/core';
import type {
  AppInfoDto,
  BranchDto,
  CommandLogEntryDto,
  CommitRequest,
  CommitResultDto,
  CommitSummaryDto,
  EnvironmentDto,
  FileDiffDto,
  OperationResultDto,
  OperationTargetDto,
  RefreshScope,
  SessionDto,
  SessionListDto,
  SessionStateDto,
  SettingsDto,
  StatusPageDto,
  StatusPageRequest,
  StatusSummaryDto,
} from '@feathertree/ipc';
import { assertInsideRoot } from '@feathertree/base-core';
import { HandlerError } from '../errors.js';

/** ページで一度に返す最大件数。renderer が巨大な要求を投げても抑える。 */
const MAX_PAGE_LIMIT = 1000;

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
}

export interface Service {
  appGetInfo(): AppInfoDto;
  appGetEnvironment(): EnvironmentDto;
  settingsGet(): SettingsDto;
  settingsUpdate(patch: Partial<SettingsDto>): Promise<SettingsDto>;
  sessionPickAndOpen(): Promise<SessionDto | null>;
  sessionOpen(root: string): Promise<SessionDto>;
  sessionList(): SessionListDto;
  sessionActivate(id: string): Promise<null>;
  sessionClose(id: string): Promise<null>;
  sessionRefresh(id: string, scope: RefreshScope): Promise<SessionStateDto>;
  sessionReorder(order: readonly string[]): Promise<null>;
  statusGetSummary(id: string): StatusSummaryDto;
  statusGetPage(id: string, req: StatusPageRequest): StatusPageDto;
  stage(id: string, target: OperationTargetDto): Promise<OperationResultDto>;
  unstage(id: string, target: OperationTargetDto): Promise<OperationResultDto>;
  discard(id: string, target: OperationTargetDto, confirmed?: boolean): Promise<OperationResultDto>;
  deleteUntracked(
    id: string,
    target: OperationTargetDto,
    confirmed?: boolean,
  ): Promise<OperationResultDto>;
  commit(id: string, req: CommitRequest, confirmed?: boolean): Promise<CommitResultDto>;
  diffGet(id: string, path: string, staged: boolean): Promise<FileDiffDto | null>;
  logGetPage(id: string, skip: number): Promise<readonly CommitSummaryDto[]>;
  branchList(id: string): readonly BranchDto[];
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

  const stateOf = (session: RepositorySession): SessionStateDto => ({
    id: session.id,
    statusSeq: session.statusSeq,
    head: session.snapshot?.head ?? null,
    counts: session.getStatusSummary().counts,
  });

  const openSession = async (root: string): Promise<SessionDto> => {
    const sessions = requireSessions();
    const session = await sessions.open(root);
    await deps.updateSettings({ openRepositories: sessions.list().map((s) => s.root) });
    return { id: session.id, root: session.root, displayName: displayNameOf(session.root) };
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

    sessionPickAndOpen: async () => {
      const picked = await deps.pickDirectory();
      if (picked === null) return null;
      return openSession(picked);
    },

    sessionOpen: (root) => openSession(root),

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

    diffGet: async (id, path, staged) => {
      const session = requireSession(id);
      assertInsideRoot(session.root, path);
      return session.getDiff(path, staged);
    },

    logGetPage: async (id, skip) => requireSession(id).getLogPage(Math.max(0, skip)),

    branchList: (id) => requireSession(id).branches,

    commandLogRecent: (limit) => deps.commandLog().recent(Math.min(Math.max(1, limit), 500)),
  };
}
