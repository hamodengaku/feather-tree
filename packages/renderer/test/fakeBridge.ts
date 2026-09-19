import type {
  BranchCreateRequest,
  FileDiffDto,
  HunkStageRequest,
  BranchDto,
  CloneOutcomeDto,
  CloneProgressEvent,
  CloneRequest,
  CommandEndEvent,
  CommandLogEntryDto,
  CommandStartEvent,
  ConflictFileDto,
  ConflictResolveRequest,
  ConflictSectionDto,
  FtErrorDto,
  GitIdentityDto,
  GitIdentityRequest,
  ProgressEvent,
  CommitFileChangeDto,
  CommitRequest,
  CommitSummaryDto,
  FeatherTreeBridge,
  FileEntryDto,
  FocusRefreshPromptEvent,
  HeadInfoDto,
  OperationTargetDto,
  PickFileKindDto,
  PushRequest,
  RefreshScope,
  Result,
  SessionChangedEvent,
  SessionDto,
  SettingsDto,
  StatusPageRequest,
  UpdateAvailableEvent,
  UpdateStateDto,
} from '@feathertree/ipc';

export interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

const SETTINGS: SettingsDto = {
  gitPath: 'C:/git/git.exe',
  sshKeyPaths: {},
  theme: 'classic-dark',
  noRenames: false,
  untrackedFiles: 'normal',
  diffContextLines: 3,
  diffMaxLines: 20000,
  logPageSize: 200,
  viewMode: 'diff',
  logDetailHeight: 260,
  commitFileListWidth: 260,
  tabShowCurrentInfo: true,
  paneWidths: { left: 260, center: 420, centerRatio: null },
  branchLocalHeight: 180,
  branchPaneCollapsed: false,
  branchExpanded: {},
  commandLogHeight: 220,
  stagedHeight: 180,
  refocusUpdateMode: 'auto',
  recentRepositories: [],
  openRepositories: [],
  checkForUpdates: true,
  lastUpdateCheckAt: null,
  dismissedUpdateVersion: null,
};

const ok = <T>(value: T): Result<T> => ({ ok: true, value });

const HEAD: HeadInfoDto = {
  oid: 'abc',
  branch: 'main',
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
};

export function entry(path: string, over: Partial<FileEntryDto> = {}): FileEntryDto {
  return { kind: 'ordinary', path, staged: '.', worktree: 'M', ...over };
}

export function commit(oid: string, over: Partial<CommitSummaryDto> = {}): CommitSummaryDto {
  return {
    oid,
    shortOid: oid.slice(0, 7),
    parents: [],
    authorName: '作者',
    authorEmail: 'author@example.com',
    authoredAt: '2026-09-10T12:00:00+09:00',
    committerName: '作者',
    committerEmail: 'author@example.com',
    committedAt: '2026-09-10T12:00:00+09:00',
    subject: `件名 ${oid}`,
    body: '',
    ...over,
  };
}

export function branch(shortName: string, over: Partial<BranchDto> = {}): BranchDto {
  return {
    refName: `refs/heads/${shortName}`,
    shortName,
    isRemote: false,
    isHead: false,
    oid: 'abc',
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    committedAt: '2026-09-10T12:00:00+09:00',
    subject: 'ダミー',
    ...over,
  };
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
  sessions: SessionDto[] = [
    { id: 's1', root: 'D:/repo-one', displayName: 'repo-one' },
    { id: 's2', root: 'D:/repo-two', displayName: 'repo-two' },
  ];
  activeId: string | null = 's1';
  /** フォルダ選択の結果。null ならユーザーがキャンセルした場合。 */
  pickResult: SessionDto | null = { id: 's3', root: 'D:/repo-three', displayName: 'repo-three' };
  /**
   * true の間、sessionLoad は releaseLoad() を呼ぶまで返らない。
   * 「読み込み中」の見え方（タブの回転印）を観察するために使う。
   */
  holdLoad = false;
  #releaseLoad: (() => void) | null = null;

  /** 保留している sessionLoad を返させる。 */
  releaseLoad(): void {
    const release = this.#releaseLoad;
    this.#releaseLoad = null;
    release?.();
  }

  /**
   * 名前を指定した呼び出しを releaseCall() まで返さない（今は sessionActivate / remoteFetch）。
   * 「main が応答するまでの間に renderer がどう見えるか」を観察するために使う。
   */
  readonly #held = new Set<string>();
  readonly #waiting = new Map<string, () => void>();

  holdCall(name: string): void {
    this.#held.add(name);
  }

  releaseCall(name: string): void {
    this.#held.delete(name);
    const release = this.#waiting.get(name);
    this.#waiting.delete(name);
    release?.();
  }

  async #gate(name: string): Promise<void> {
    if (!this.#held.has(name)) return;
    await new Promise<void>((release) => this.#waiting.set(name, release));
  }

  /**
   * 設定更新の応答を保留するための待ち行列（FIFO）。
   *
   * 既定（`deferSettings = false`）では即座に解決するので、
   * 「応答が遅れている間に別の設定を書いた」というレース——ペイン幅のドラッグの応答が
   * 後から届いてフォルダの展開状態を巻き戻す——を再現できない。
   * `deferSettingsUpdate()` を呼ぶと、以後の settingsUpdate は
   * `resolveSettingsUpdate()` / `rejectSettingsUpdate()` を呼ぶまで返らない。
   * **保留中は main 側の設定も書き換えない**（実物と同じく、適用は応答の時点）。
   */
  deferSettings = false;
  readonly #pendingSettings: {
    readonly patch: Partial<SettingsDto>;
    readonly settle: () => void;
    readonly fail: (error: unknown) => void;
  }[] = [];

  /** 以後の settingsUpdate を保留する。 */
  deferSettingsUpdate(): void {
    this.deferSettings = true;
  }

  /** 保留中の settingsUpdate を、古い順に 1 件だけ成功させる。 */
  resolveSettingsUpdate(): void {
    this.#pendingSettings.shift()?.settle();
  }

  /** 保留中の settingsUpdate を、古い順に 1 件だけ reject する（IPC の失敗を模す）。 */
  rejectSettingsUpdate(error: unknown = new Error('設定を保存できませんでした')): void {
    this.#pendingSettings.shift()?.fail(error);
  }

  /** まだ返していない settingsUpdate の件数。 */
  get pendingSettingsUpdates(): number {
    return this.#pendingSettings.length;
  }

  /** クローンの保存先選択の結果。null ならキャンセル。 */
  clonePickResult: string | null = 'D:/work';
  /** 設定画面のファイル選択（git.exe / SSH 鍵）の結果。null ならキャンセル。 */
  pickFileResult: string | null = null;
  /** main が解決した ssh の絶対パス。null なら未検出（＝鍵を登録しても注入されない）。 */
  sshPath: string | null = 'C:/Windows/System32/OpenSSH/ssh.exe';
  /** main が持っているコミット情報（対応表 #42〜#44）。 */
  gitIdentity: GitIdentityDto = {
    name: { value: 'Local Name', scope: 'local' },
    email: { value: 'local@example.invalid', scope: 'local' },
  };
  /** 保存を失敗させる（値の検証違反の再現）。 */
  gitIdentityError: FtErrorDto | null = null;
  /** sessionCloneAndCreate の結果。session が null でなければタブが立つ（main と同じ）。 */
  cloneOutcome: CloneOutcomeDto = {
    result: 'succeeded',
    cancelled: false,
    session: { id: 's4', root: 'D:/work/cloned', displayName: 'cloned' },
    target: 'D:\\work\\cloned',
    stages: [],
    hints: [],
    followUps: [],
    log: 'FeatherTree クローンログ',
  };
  /** null でなければ sessionCloneAndCreate はこのエラーで失敗する（入力検証の違反など）。 */
  cloneError: FtErrorDto | null = null;
  /** true の間、sessionCloneAndCreate は releaseClone() を呼ぶまで返らない（進捗の観察用）。 */
  holdClone = false;
  #releaseClone: (() => void) | null = null;
  progressListeners: ((e: ProgressEvent) => void)[] = [];
  cloneProgressListeners: ((e: CloneProgressEvent) => void)[] = [];

  releaseClone(): void {
    const release = this.#releaseClone;
    this.#releaseClone = null;
    release?.();
  }

  /** main がクローンの段階表を送ってきたことにする。 */
  emitCloneProgress(event: CloneProgressEvent): void {
    for (const listener of this.cloneProgressListeners) listener(event);
  }
  /** detached HEAD などを再現できるようにテストから差し替える。 */
  head: HeadInfoDto = HEAD;
  /** main が保持しているブランチ一覧。外部での変更を再現するときに差し替える。 */
  branches: BranchDto[] = [];
  /** main が保持しているリモート名。複数リモートの分岐を再現するときに差し替える。 */
  remotes: string[] = ['origin'];
  /** logGetPage が返す履歴の全体。skip / logPageSize で切り出す。 */
  commits: CommitSummaryDto[] = [];
  /** commitGetFiles が返す変更ファイル。マージコミットを再現するときは空にする。 */
  commitFiles: CommitFileChangeDto[] = [];
  /**
   * main が保持している設定。settingsUpdate で書き換わり、次の settingsGet に反映される（実物と同じ）。
   * logPageSize のような「取得の振る舞いを変える設定」をテストから差し替えられるように可変にしてある。
   */
  settings: SettingsDto = { ...SETTINGS };
  seq = 1;
  /** この名前の書き込み操作で 'needs-confirmation' を返す。 */
  requireConfirmation: string | null = null;
  confirmedCalls: string[] = [];
  changedListeners: ((e: SessionChangedEvent) => void)[] = [];
  focusPromptListeners: ((e: FocusRefreshPromptEvent) => void)[] = [];
  commandStartListeners: ((e: CommandStartEvent) => void)[] = [];
  commandEndListeners: ((e: CommandEndEvent) => void)[] = [];
  commandLoggedListeners: ((e: CommandLogEntryDto) => void)[] = [];
  /** main が保持しているコマンドログ（新しい順）。commandLogRecent が返す。 */
  commandLogEntries: CommandLogEntryDto[] = [];

  /** main が保持している更新確認の状態（決定 29）。updateGetState / updateCheckNow が返す。 */
  updateState: UpdateStateDto = { outcome: 'unknown', version: null };
  updateAvailableListeners: ((e: UpdateAvailableEvent) => void)[] = [];

  /** main が起動時の自動確認で新版を見つけたことにする。 */
  emitUpdateAvailable(version: string): void {
    this.updateState = { outcome: 'new-version', version };
    for (const listener of this.updateAvailableListeners) listener({ version });
  }

  /** main がコマンドログに 1 件足して通知してきたことにする（保持分にも足す）。 */
  emitCommandLogged(entry: CommandLogEntryDto): void {
    this.commandLogEntries = [entry, ...this.commandLogEntries];
    for (const listener of this.commandLoggedListeners) listener(entry);
  }

  /** diffGet の応答を遅らせる（世代番号による競合排除の検証用）。 */
  diffDelayMs = 0;

  /**
   * conflictGet が返す衝突。テストから差し替えられるようにしてある
   * （既定は 1 件。採用すると conflictResolve がここから取り除く）。
   */
  conflictSections: readonly ConflictSectionDto[] = [
    {
      index: 0,
      startLine: 1,
      endLine: 5,
      ourLabel: 'HEAD',
      theirLabel: 'feature',
      baseLabel: null,
      ourCount: 1,
      theirCount: 1,
      lines: [],
      truncated: false,
    },
  ];

  /** conflictGet が返す中身。パスが分かるようにしておく。 */
  conflictFor(path: string): ConflictFileDto {
    return {
      path,
      binary: false,
      malformed: false,
      sections: this.conflictSections,
      truncated: false,
    };
  }

  /** diffGet が返す中身。パスが分かるようにしておく。 */
  diffFor(path: string): FileDiffDto {
    return {
      path,
      oldPath: null,
      binary: false,
      hunks: [],
      truncated: false,
      hunkStageable: true,
    };
  }

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

  emitFocusPrompt(sessionId: string): void {
    for (const listener of this.focusPromptListeners) {
      listener({ sessionId });
    }
  }

  /** main が git を走らせ始めた／走り終えたことにする。 */
  emitCommandStart(event: CommandStartEvent): void {
    for (const listener of this.commandStartListeners) listener(event);
  }

  emitCommandEnd(opId: string): void {
    for (const listener of this.commandEndListeners) listener({ opId });
  }

  /** kind:'paths' の対象を staged⇄changes 間で実際に移動させる（テストで移動先を検証するため）。 */
  #moveByPaths(target: OperationTargetDto, from: FileEntryDto[], to: FileEntryDto[]): void {
    if (target.kind !== 'paths') return;
    for (const path of target.paths) {
      const index = from.findIndex((e) => e.path === path);
      if (index === -1) continue;
      const [moved] = from.splice(index, 1);
      if (moved !== undefined) to.push(moved);
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
            sshPath: this.sshPath,
            warning: null,
          }),
        );
      },
      settingsGet: () => {
        this.record('settingsGet');
        return Promise.resolve(ok(this.settings));
      },
      settingsUpdate: (patch: Partial<SettingsDto>) => {
        /*
         * 本物の IPC と同じく structured clone を通す（$state の Proxy を渡すとここで投げる）。
         * sessionCloneAndCreate と同じ理由で、preload の境界を素通りさせない。
         */
        this.record('settingsUpdate', structuredClone(patch));
        const apply = (): Result<SettingsDto> => {
          this.settings = { ...this.settings, ...patch };
          return ok(this.settings);
        };
        if (!this.deferSettings) return Promise.resolve(apply());
        return new Promise<Result<SettingsDto>>((resolve, reject) => {
          this.#pendingSettings.push({
            patch,
            settle: () => resolve(apply()),
            fail: (error) => reject(error),
          });
        });
      },
      dialogPickFile: (kind: PickFileKindDto) => {
        this.record('dialogPickFile', kind);
        return Promise.resolve(ok(this.pickFileResult));
      },
      gitConfigGetIdentity: (id: string) => {
        this.record('gitConfigGetIdentity', id);
        return Promise.resolve(ok(this.gitIdentity));
      },
      sshSetKey: (id: string, keyPath: string | null) => {
        this.record('sshSetKey', id, keyPath);
        const root = this.sessions.find((s) => s.id === id)?.root;
        if (root === undefined) return Promise.resolve(ok(this.settings));
        // main と同じく、その 1 リポジトリだけを足し引きする
        const next: Record<string, string> = { ...this.settings.sshKeyPaths };
        if (keyPath === null) delete next[root];
        else next[root] = keyPath;
        this.settings = { ...this.settings, sshKeyPaths: next };
        return Promise.resolve(ok(this.settings));
      },
      gitConfigSetIdentity: (id: string, req: GitIdentityRequest) => {
        this.record('gitConfigSetIdentity', id, structuredClone(req));
        if (this.gitIdentityError !== null) return Promise.resolve({ ok: false as const, error: this.gitIdentityError });
        // main と同じく、書いたキーはローカル値になる
        const next = { ...this.gitIdentity };
        if (req.name !== null) next.name = { value: req.name, scope: 'local' };
        if (req.email !== null) next.email = { value: req.email, scope: 'local' };
        this.gitIdentity = next;
        return Promise.resolve(ok(null));
      },
      sessionPickAndCreate: () => {
        this.record('sessionPickAndCreate');
        const picked = this.pickResult;
        if (picked === null) return Promise.resolve(ok(null));
        // main 側と同じく、この時点でタブは立ちアクティブになる（一覧はまだ取らない）
        if (!this.sessions.some((s) => s.id === picked.id)) this.sessions = [...this.sessions, picked];
        this.activeId = picked.id;
        return Promise.resolve(ok(picked));
      },
      sessionLoad: async (id: string) => {
        this.record('sessionLoad', id);
        if (this.holdLoad) await new Promise<void>((release) => (this.#releaseLoad = release));
        return ok(null);
      },
      sessionOpen: (root: string) => {
        this.record('sessionOpen', root);
        return Promise.resolve(ok(this.sessions[0] ?? { id: 's1', root, displayName: root }));
      },
      clonePickDirectory: () => {
        this.record('clonePickDirectory');
        return Promise.resolve(ok(this.clonePickResult));
      },
      sessionCloneAndCreate: async (req: CloneRequest) => {
        // 本物の IPC と同じく structured clone を通す（$state の Proxy を渡すとここで投げる）
        this.record('sessionCloneAndCreate', structuredClone(req));
        if (this.holdClone) await new Promise<void>((release) => (this.#releaseClone = release));
        if (this.cloneError !== null) return { ok: false, error: this.cloneError };
        const outcome = this.cloneOutcome;
        const created = outcome.session;
        if (created !== null) {
          if (!this.sessions.some((s) => s.id === created.id)) this.sessions = [...this.sessions, created];
          this.activeId = created.id;
        }
        return ok(outcome);
      },
      cloneCancel: () => {
        this.record('cloneCancel');
        return Promise.resolve(ok(null));
      },
      sessionList: () => {
        this.record('sessionList');
        return Promise.resolve(ok({ sessions: this.sessions, activeId: this.activeId }));
      },
      sessionActivate: async (id: string) => {
        this.record('sessionActivate', id);
        await this.#gate('sessionActivate');
        this.activeId = id;
        return ok(null);
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
        return Promise.resolve(ok({ id, statusSeq: this.seq, head: this.head, counts: this.counts() }));
      },
      sessionReorder: (order: readonly string[]) => {
        this.record('sessionReorder', order);
        const byId = new Map(this.sessions.map((s) => [s.id, s]));
        const next = order.map((id) => byId.get(id)).filter((s): s is (typeof this.sessions)[number] => s !== undefined);
        for (const s of this.sessions) if (!order.includes(s.id)) next.push(s);
        this.sessions = next;
        return Promise.resolve(ok(null));
      },
      statusGetSummary: (id: string) => {
        this.record('statusGetSummary', id);
        return Promise.resolve(
          ok({ seq: this.seq, counts: this.counts(), head: this.head, hasSnapshot: true }),
        );
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
        this.#moveByPaths(target, this.changes, this.staged);
        return Promise.resolve(ok({ affected: 1, statusSeq: this.seq }));
      },
      unstage: (id: string, target: OperationTargetDto) => {
        this.record('unstage', id, target);
        this.#moveByPaths(target, this.staged, this.changes);
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
        const diff: FileDiffDto = this.diffFor(path);
        return this.diffDelayMs === 0
          ? Promise.resolve(ok(diff))
          : new Promise((resolve) => {
              setTimeout(() => resolve(ok(diff)), this.diffDelayMs);
            });
      },
      conflictGet: (id: string, path: string) => {
        this.record('conflictGet', id, path);
        const file: ConflictFileDto = this.conflictFor(path);
        return this.diffDelayMs === 0
          ? Promise.resolve(ok(file))
          : new Promise((resolve) => {
              setTimeout(() => resolve(ok(file)), this.diffDelayMs);
            });
      },
      conflictResolve: (id: string, req: ConflictResolveRequest) => {
        this.record('conflictResolve', id, req);
        this.conflictSections = this.conflictSections.filter((s) => s.index !== req.section.index);
        return Promise.resolve(ok({ remaining: this.conflictSections.length }));
      },
      stageHunks: (id: string, req: HunkStageRequest) => {
        this.record('stageHunks', id, req);
        this.seq += 1;
        return Promise.resolve(ok({ affected: req.hunks.length, statusSeq: this.seq }));
      },
      unstageHunks: (id: string, req: HunkStageRequest) => {
        this.record('unstageHunks', id, req);
        this.seq += 1;
        return Promise.resolve(ok({ affected: req.hunks.length, statusSeq: this.seq }));
      },
      logGetPage: (id: string, skip: number) => {
        this.record('logGetPage', id, skip);
        return Promise.resolve(ok(this.commits.slice(skip, skip + this.settings.logPageSize)));
      },
      commitGetFiles: (id: string, oid: string) => {
        this.record('commitGetFiles', id, oid);
        return Promise.resolve(ok(this.commitFiles));
      },
      commitGetDiff: (id: string, oid: string, path: string) => {
        this.record('commitGetDiff', id, oid, path);
        // コミットの差分はステージできない（main 側が必ず false を入れる）
        return Promise.resolve(ok({ ...this.diffFor(path), hunkStageable: false }));
      },
      branchList: (id: string) => {
        this.record('branchList', id);
        return Promise.resolve(ok(this.branches));
      },
      branchSwitch: (id: string, branchName: string) => {
        this.record('branchSwitch', id, branchName);
        this.seq += 1;
        return Promise.resolve(ok({ statusSeq: this.seq }));
      },
      branchCreate: (id: string, req: BranchCreateRequest) => {
        this.record('branchCreate', id, req);
        this.seq += 1;
        return Promise.resolve(ok({ statusSeq: this.seq }));
      },
      branchMerge: (id: string, branchName: string, confirmed?: boolean) => {
        this.record('branchMerge', id, branchName, confirmed);
        const result = this.guard('branchMerge', 'merge-branch', confirmed, { statusSeq: this.seq + 1 });
        if (result.ok) this.seq += 1;
        return Promise.resolve(result);
      },
      remoteList: (id: string) => {
        this.record('remoteList', id);
        return Promise.resolve(ok(this.remotes));
      },
      remoteFetch: async (id: string, remote: string) => {
        this.record('remoteFetch', id, remote);
        await this.#gate('remoteFetch');
        this.seq += 1;
        return ok({ statusSeq: this.seq });
      },
      remotePull: (id: string) => {
        this.record('remotePull', id);
        this.seq += 1;
        return Promise.resolve(ok({ statusSeq: this.seq }));
      },
      remotePush: (id: string, req: PushRequest) => {
        this.record('remotePush', id, req);
        this.seq += 1;
        return Promise.resolve(ok({ statusSeq: this.seq }));
      },
      shellOpenPath: (id: string, path: string, confirmed?: boolean) => {
        this.record('shellOpenPath', id, path, confirmed);
        return Promise.resolve(
          this.guard('shellOpenPath', 'open-executable-file', confirmed, undefined),
        );
      },
      shellShowInFolder: (id: string, path: string) => {
        this.record('shellShowInFolder', id, path);
        return Promise.resolve(ok(undefined));
      },
      shellOpenTerminal: (id: string) => {
        this.record('shellOpenTerminal', id);
        return Promise.resolve(ok(undefined));
      },
      commandLogRecent: (limit: number) => {
        this.record('commandLogRecent', limit);
        return Promise.resolve(ok(this.commandLogEntries.slice(0, limit)));
      },
      updateGetState: () => {
        this.record('updateGetState');
        return Promise.resolve(ok(this.updateState));
      },
      updateCheckNow: () => {
        this.record('updateCheckNow');
        return Promise.resolve(ok(this.updateState));
      },
      updateOpenReleasePage: () => {
        this.record('updateOpenReleasePage');
        return Promise.resolve(ok(undefined));
      },
      updateDismiss: () => {
        this.record('updateDismiss');
        this.updateState = { outcome: 'up-to-date', version: null };
        return Promise.resolve(ok(undefined));
      },
      onSessionChanged: (listener) => {
        this.changedListeners.push(listener);
        return () => {
          this.changedListeners = this.changedListeners.filter((l) => l !== listener);
        };
      },
      onProgress: (listener) => {
        this.progressListeners.push(listener);
        return () => {
          this.progressListeners = this.progressListeners.filter((l) => l !== listener);
        };
      },
      onCloneProgress: (listener) => {
        this.cloneProgressListeners.push(listener);
        return () => {
          this.cloneProgressListeners = this.cloneProgressListeners.filter((l) => l !== listener);
        };
      },
      onFocusRefreshPrompt: (listener) => {
        this.focusPromptListeners.push(listener);
        return () => {
          this.focusPromptListeners = this.focusPromptListeners.filter((l) => l !== listener);
        };
      },
      onCommandStart: (listener) => {
        this.commandStartListeners.push(listener);
        return () => {
          this.commandStartListeners = this.commandStartListeners.filter((l) => l !== listener);
        };
      },
      onCommandEnd: (listener) => {
        this.commandEndListeners.push(listener);
        return () => {
          this.commandEndListeners = this.commandEndListeners.filter((l) => l !== listener);
        };
      },
      onCommandLogged: (listener) => {
        this.commandLoggedListeners.push(listener);
        return () => {
          this.commandLoggedListeners = this.commandLoggedListeners.filter((l) => l !== listener);
        };
      },
      onUpdateAvailable: (listener) => {
        this.updateAvailableListeners.push(listener);
        return () => {
          this.updateAvailableListeners = this.updateAvailableListeners.filter((l) => l !== listener);
        };
      },
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
