import type {
  CommitRequest,
  FeatherTreeBridge,
  FileEntryDto,
  OperationTargetDto,
  RefreshScope,
  Result,
  SessionChangedEvent,
  SettingsDto,
  StatusPageRequest,
} from '@feathertree/ipc';

export interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

const SETTINGS: SettingsDto = {
  gitPath: 'C:/git/git.exe',
  theme: 'dark',
  noRenames: false,
  untrackedFiles: 'normal',
  diffContextLines: 3,
  diffMaxLines: 20000,
  logPageSize: 200,
  paneWidths: { left: 260, center: 420 },
  recentRepositories: [],
  openRepositories: [],
};

const ok = <T>(value: T): Result<T> => ({ ok: true, value });

const HEAD = { oid: 'abc', branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0 };

export function entry(path: string, over: Partial<FileEntryDto> = {}): FileEntryDto {
  return { kind: 'ordinary', path, staged: '.', worktree: 'M', ...over };
}

/**
 * main プロセスの代役。
 * どのチャネルが何回呼ばれたかを記録し、
 * 「タブ切替で一覧を取り直さない」「確認は main が強制する」などを検証できるようにする。
 */
export class FakeBridge {
  readonly calls: Call[] = [];
  staged: FileEntryDto[] = [];
  changes: FileEntryDto[] = [];
  sessions = [
    { id: 's1', root: 'D:/repo-one', displayName: 'repo-one' },
    { id: 's2', root: 'D:/repo-two', displayName: 'repo-two' },
  ];
  activeId: string | null = 's1';
  seq = 1;
  /** この名前の書き込み操作で 'needs-confirmation' を返す。 */
  requireConfirmation: string | null = null;
  confirmedCalls: string[] = [];
  changedListeners: ((e: SessionChangedEvent) => void)[] = [];

  countOf(name: string): number {
    return this.calls.filter((c) => c.name === name).length;
  }

  lastArgsOf(name: string): readonly unknown[] | null {
    const found = [...this.calls].reverse().find((c) => c.name === name);
    return found?.args ?? null;
  }

  emitChanged(sessionId: string): void {
    for (const listener of this.changedListeners) {
      listener({ sessionId, change: 'status', statusSeq: this.seq });
    }
  }

  record(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }

  counts() {
    return {
      staged: this.staged.length,
      unstaged: this.changes.filter((e) => e.kind === 'ordinary').length,
      untracked: this.changes.filter((e) => e.kind === 'untracked').length,
      unmerged: this.changes.filter((e) => e.kind === 'unmerged').length,
      total: this.staged.length + this.changes.length,
    };
  }

  /** main 側の確認強制を模す。confirmed が真でなければ needs-confirmation を返す。 */
  guard<T>(name: string, action: string, confirmed: boolean | undefined, value: T): Result<T> {
    if (this.requireConfirmation === name && confirmed !== true) {
      return {
        ok: false,
        error: {
          kind: 'needs-confirmation',
          message: '確認が必要です',
          confirmation: {
            action,
            title: '確認',
            message: '本当に実行しますか',
            confirmLabel: '実行',
            recoverable: false,
          },
        },
      };
    }
    if (confirmed === true) this.confirmedCalls.push(name);
    return { ok: true, value };
  }

  build(): FeatherTreeBridge {
    return {
      appGetInfo: () => {
        this.record('appGetInfo');
        return Promise.resolve(
          ok({
            appVersion: '0.0.0',
            electronVersion: '44',
            chromeVersion: '144',
            nodeVersion: '24',
            userDataDir: 'D:/data',
            isPackaged: false,
          }),
        );
      },
      appGetEnvironment: () => {
        this.record('appGetEnvironment');
        return Promise.resolve(
          ok({
            gitPath: 'C:/git/git.exe',
            gitSource: 'path' as const,
            gitVersion: 'git version 2.40.0',
            warning: null,
          }),
        );
      },
      settingsGet: () => {
        this.record('settingsGet');
        return Promise.resolve(ok(SETTINGS));
      },
      settingsUpdate: (patch: Partial<SettingsDto>) => {
        this.record('settingsUpdate', patch);
        return Promise.resolve(ok({ ...SETTINGS, ...patch }));
      },
      sessionPickAndOpen: () => {
        this.record('sessionPickAndOpen');
        return Promise.resolve(ok(this.sessions[0] ?? null));
      },
      sessionOpen: (root: string) => {
        this.record('sessionOpen', root);
        return Promise.resolve(ok(this.sessions[0] ?? { id: 's1', root, displayName: root }));
      },
      sessionList: () => {
        this.record('sessionList');
        return Promise.resolve(ok({ sessions: this.sessions, activeId: this.activeId }));
      },
      sessionActivate: (id: string) => {
        this.record('sessionActivate', id);
        this.activeId = id;
        return Promise.resolve(ok(null));
      },
      sessionClose: (id: string) => {
        this.record('sessionClose', id);
        this.sessions = this.sessions.filter((s) => s.id !== id);
        this.activeId = this.sessions[0]?.id ?? null;
        return Promise.resolve(ok(null));
      },
      sessionRefresh: (id: string, scope: RefreshScope) => {
        this.record('sessionRefresh', id, scope);
        this.seq += 1;
        return Promise.resolve(ok({ id, statusSeq: this.seq, head: HEAD, counts: this.counts() }));
      },
      statusGetSummary: (id: string) => {
        this.record('statusGetSummary', id);
        return Promise.resolve(ok({ seq: this.seq, counts: this.counts(), head: HEAD, hasSnapshot: true }));
      },
      statusGetPage: (id: string, req: StatusPageRequest) => {
        this.record('statusGetPage', id, req);
        const source = req.filter?.group === 'staged' ? this.staged : this.changes;
        return Promise.resolve(
          ok({
            seq: this.seq,
            offset: req.offset,
            entries: source.slice(req.offset, req.offset + req.limit),
            filteredTotal: source.length,
          }),
        );
      },
      stage: (id: string, target: OperationTargetDto) => {
        this.record('stage', id, target);
        return Promise.resolve(ok({ affected: 1, statusSeq: this.seq }));
      },
      unstage: (id: string, target: OperationTargetDto) => {
        this.record('unstage', id, target);
        return Promise.resolve(ok({ affected: 1, statusSeq: this.seq }));
      },
      discard: (id: string, target: OperationTargetDto, confirmed?: boolean) => {
        this.record('discard', id, target, confirmed);
        return Promise.resolve(
          this.guard('discard', 'discard-changes', confirmed, { affected: 1, statusSeq: this.seq }),
        );
      },
      deleteUntracked: (id: string, target: OperationTargetDto, confirmed?: boolean) => {
        this.record('deleteUntracked', id, target, confirmed);
        return Promise.resolve(
          this.guard('deleteUntracked', 'delete-untracked', confirmed, {
            affected: 1,
            statusSeq: this.seq,
          }),
        );
      },
      commit: (id: string, req: CommitRequest, confirmed?: boolean) => {
        this.record('commit', id, req, confirmed);
        return Promise.resolve(
          this.guard('commit', 'amend-pushed-commit', confirmed, { oid: 'newoid', statusSeq: this.seq }),
        );
      },
      diffGet: (id: string, path: string, staged: boolean) => {
        this.record('diffGet', id, path, staged);
        return Promise.resolve(ok({ path, oldPath: null, binary: false, hunks: [], truncated: false }));
      },
      logGetPage: (id: string, skip: number) => {
        this.record('logGetPage', id, skip);
        return Promise.resolve(ok([]));
      },
      branchList: (id: string) => {
        this.record('branchList', id);
        return Promise.resolve(ok([]));
      },
      commandLogRecent: (limit: number) => {
        this.record('commandLogRecent', limit);
        return Promise.resolve(ok([]));
      },
      onSessionChanged: (listener) => {
        this.changedListeners.push(listener);
        return () => {
          this.changedListeners = this.changedListeners.filter((l) => l !== listener);
        };
      },
      onProgress: () => () => undefined,
    };
  }
}

/**
 * applyTheme が触る document だけを最小限用意する（jsdom は入れない）。
 * bridge は AppState のコンストラクタで注入するので window は不要。
 */
export function installDocumentStub(): void {
  Object.defineProperty(globalThis, 'document', {
    value: {
      documentElement: {
        style: {
          setProperty(): void {
            // テストでは適用結果を見ないので何もしない
          },
        },
      },
    },
    configurable: true,
    writable: true,
  });
}
