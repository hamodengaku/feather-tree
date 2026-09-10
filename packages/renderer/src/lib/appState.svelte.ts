import type { FeatherTreeBridge } from '@feathertree/ipc';
import type {
  BranchDto,
  CommandLogEntryDto,
  ConfirmationDto,
  EnvironmentDto,
  FileDiffDto,
  FileEntryDto,
  FtErrorDto,
  OperationTargetDto,
  Result,
  SessionDto,
  SettingsDto,
  StatusGroupDto,
  StatusSummaryDto,
} from '@feathertree/ipc';
import { SvelteMap } from 'svelte/reactivity';
import { ft } from '../bridge.js';
import { applyTheme } from './theme.js';

/** 1 セクションが一度に取得する件数。仮想化しているので画面分 + 余裕で足りる。 */
const PAGE_LIMIT = 200;

export interface SelectedFile {
  readonly path: string;
  readonly staged: boolean;
}

export interface PendingConfirmation {
  readonly confirmation: ConfirmationDto;
  /** 承認されたら再実行する処理。 */
  readonly retry: () => Promise<void>;
}

export interface Section {
  entries: (FileEntryDto | undefined)[];
  total: number;
}

function emptySection(): Section {
  return { entries: [], total: 0 };
}

/**
 * renderer の状態。
 *
 * 重要な制約:
 *  - タブ切替では一覧を取り直さない（保持済みの状態を表示するだけ）
 *  - 一覧は常にページングで取得し、全件を renderer に持たない
 *  - 破棄などの確認は main 側が 'needs-confirmation' で拒否してくるので、それを受けて出す
 */
export class AppState {
  readonly #ft: FeatherTreeBridge;

  constructor(bridge: FeatherTreeBridge) {
    this.#ft = bridge;
  }

  environment = $state<EnvironmentDto | null>(null);
  settings = $state<SettingsDto | null>(null);

  sessions = $state<SessionDto[]>([]);
  activeId = $state<string | null>(null);

  summary = $state<StatusSummaryDto | null>(null);
  staged = $state<Section>(emptySection());
  changes = $state<Section>(emptySection());

  /**
   * ブランチ一覧（ローカル・リモートの両方）。
   * main のスナップショットを読むだけで git は動かない（#3 を実行するのは main 側）。
   */
  branches = $state<readonly BranchDto[]>([]);

  selected = $state<SelectedFile | null>(null);
  diff = $state<FileDiffDto | null>(null);
  diffLoading = $state(false);

  commitMessage = $state('');
  amend = $state(false);

  busy = $state(false);
  error = $state<FtErrorDto | null>(null);
  pendingConfirmation = $state<PendingConfirmation | null>(null);
  focusRefreshPrompt = $state<{ sessionId: string } | null>(null);

  commandLog = $state<CommandLogEntryDto[]>([]);
  showCommandLog = $state(false);

  /**
   * 「新しいブランチを作成」ダイアログの開閉。
   * 開くボタンはブランチペインにあるが、ダイアログ自体は App.svelte の最上位に置く
   * （ペインの中に position: fixed を置くと後続のペインに隠れる）。
   */
  createBranchOpen = $state(false);

  /** セッションごとの状態。タブ切替で一覧を取り直さないためのキャッシュ。 */
  readonly #cache = new SvelteMap<
    string,
    {
      summary: StatusSummaryDto | null;
      staged: Section;
      changes: Section;
      selected: SelectedFile | null;
      branches: readonly BranchDto[];
    }
  >();

  get activeSession(): SessionDto | null {
    return this.sessions.find((s) => s.id === this.activeId) ?? null;
  }

  get canCommit(): boolean {
    if (this.busy || this.activeId === null) return false;
    if (this.commitMessage.trim().length === 0) return false;
    return this.amend || (this.summary?.counts.staged ?? 0) > 0;
  }

  /** 今いるブランチ名。detached HEAD やリポジトリ未取得では null（作成の起点に使えない）。 */
  get currentBranch(): string | null {
    const head = this.summary?.head ?? null;
    if (head === null || head.detached) return null;
    return head.branch;
  }

  async initialize(): Promise<void> {
    const [env, settings, list] = await Promise.all([
      this.#ft.appGetEnvironment(),
      this.#ft.settingsGet(),
      this.#ft.sessionList(),
    ]);

    if (env.ok) this.environment = env.value;
    if (settings.ok) {
      this.settings = settings.value;
      applyTheme(settings.value.theme);
    }
    if (list.ok) {
      this.sessions = [...list.value.sessions];
      this.activeId = list.value.activeId;
      if (this.activeId !== null) await this.reloadAll();
    }

    // main 側の自動更新（ウィンドウ復帰時）を受けて表示を合わせる
    this.#ft.onSessionChanged((event) => {
      if (event.sessionId !== this.activeId) return;
      void this.reloadActive();
    });

    // refocusUpdateMode === 'modal' のとき、main はここに「更新するか」を委ねてくる
    this.#ft.onFocusRefreshPrompt((event) => {
      if (event.sessionId !== this.activeId) return;
      this.focusRefreshPrompt = event;
    });
  }

  async openRepository(): Promise<void> {
    await this.#run(async () => {
      const result = await this.#ft.sessionPickAndOpen();
      if (!this.#check(result) || result.value === null) return;
      const list = await this.#ft.sessionList();
      if (list.ok) {
        this.sessions = [...list.value.sessions];
        this.activeId = result.value.id;
      }
      this.#clearActive();
      await this.reloadAll();
    });
  }

  /** タブ切替。一覧の取り直しはせず、キャッシュから復元する。 */
  async activate(id: string): Promise<void> {
    if (id === this.activeId) return;
    this.#saveCache();
    const result = await this.#ft.sessionActivate(id);
    if (!this.#check(result)) return;

    this.activeId = id;
    const cached = this.#cache.get(id);
    if (cached === undefined) {
      this.#clearActive();
      await this.reloadAll();
      return;
    }
    this.summary = cached.summary;
    this.staged = cached.staged;
    this.changes = cached.changes;
    this.selected = cached.selected;
    this.branches = cached.branches;
    this.diff = null;
    if (cached.selected !== null) await this.loadDiff(cached.selected);
  }

  /** タブのドラッグ並び替え中のプレビュー。IPC は呼ばない。 */
  reorderTabs(order: readonly string[]): void {
    const sessions = this.sessions;
    this.sessions = order
      .map((id) => sessions.find((s) => s.id === id))
      .filter((s): s is SessionDto => s !== undefined);
  }

  /** ドロップ確定時に一度だけ呼び、並び順を main 側（再起動用の openRepositories 含む）に反映する。 */
  async commitTabOrder(): Promise<void> {
    const result = await this.#ft.sessionReorder(this.sessions.map((s) => s.id));
    this.#check(result);
  }

  async closeTab(id: string): Promise<void> {
    const result = await this.#ft.sessionClose(id);
    if (!this.#check(result)) return;
    this.#cache.delete(id);

    const list = await this.#ft.sessionList();
    if (!list.ok) return;
    this.sessions = [...list.value.sessions];
    this.activeId = list.value.activeId;
    this.#clearActive();
    if (this.activeId !== null) await this.reloadAll();
  }

  /**
   * 手動更新。決定 14 のもう一方の入口。
   *
   * 非アクティブの間に外部（ターミナル・他のツール）でブランチが操作されている可能性があるため、
   * 表示しているものはすべて取り直す。git の実行回数は main 側の scope が決めるので、
   * ここでブランチを読み直しても git は増えない（#3 は 'full' のときに main が既に実行済み）。
   */
  async refresh(scope: 'status' | 'full' = 'full'): Promise<void> {
    const id = this.activeId;
    if (id === null) return;
    await this.#run(async () => {
      const result = await this.#ft.sessionRefresh(id, scope);
      if (!this.#check(result)) return;
      await this.reloadAll();
    });
  }

  /**
   * 表示物をすべて取り直す（更新ボタン・タブの切り替わり）。
   * 書き込み操作の後は main がブランチを取り直さないので、こちらではなく reloadActive を使う。
   */
  async reloadAll(): Promise<void> {
    await this.reloadActive();
    await this.reloadBranches();
  }

  /** ブランチ一覧の取り直し。main のスナップショットを読むだけで git は動かない。 */
  async reloadBranches(): Promise<void> {
    const id = this.activeId;
    if (id === null) return;
    const result = await this.#ft.branchList(id);
    if (result.ok) this.branches = [...result.value];
  }

  async reloadActive(): Promise<void> {
    const id = this.activeId;
    if (id === null) return;

    const [summary, staged, changes] = await Promise.all([
      this.#ft.statusGetSummary(id),
      this.#ft.statusGetPage(id, { offset: 0, limit: PAGE_LIMIT, filter: { group: 'staged' } }),
      this.#ft.statusGetPage(id, { offset: 0, limit: PAGE_LIMIT, filter: { group: 'changes' } }),
    ]);

    if (summary.ok) this.summary = summary.value;
    if (staged.ok) this.staged = { entries: [...staged.value.entries], total: staged.value.filteredTotal };
    if (changes.ok) this.changes = { entries: [...changes.value.entries], total: changes.value.filteredTotal };

    if (this.selected !== null && !this.#stillPresent(this.selected)) {
      this.selected = null;
      this.diff = null;
    } else if (this.selected !== null) {
      await this.loadDiff(this.selected);
    }
    await this.reloadCommandLog();
  }

  /** 仮想リストのスクロールに応じて追加のページを取る。 */
  async loadMore(group: StatusGroupDto, offset: number): Promise<void> {
    const id = this.activeId;
    if (id === null) return;
    const section = group === 'staged' ? this.staged : this.changes;
    if (offset >= section.total || section.entries[offset] !== undefined) return;

    const page = await this.#ft.statusGetPage(id, { offset, limit: PAGE_LIMIT, filter: { group } });
    if (!page.ok) return;

    const merged = [...section.entries];
    page.value.entries.forEach((entry, i) => {
      merged[page.value.offset + i] = entry;
    });
    const next: Section = { entries: merged, total: page.value.filteredTotal };
    if (group === 'staged') this.staged = next;
    else this.changes = next;
  }

  async select(file: SelectedFile): Promise<void> {
    this.selected = file;
    await this.loadDiff(file);
  }

  async loadDiff(file: SelectedFile): Promise<void> {
    const id = this.activeId;
    if (id === null) return;
    this.diffLoading = true;
    try {
      const result = await this.#ft.diffGet(id, file.path, file.staged);
      if (result.ok) this.diff = result.value;
      else this.diff = null;
    } finally {
      this.diffLoading = false;
    }
  }

  async reloadCommandLog(): Promise<void> {
    const result = await this.#ft.commandLogRecent(200);
    if (result.ok) this.commandLog = [...result.value];
  }

  async setTheme(theme: SettingsDto['theme']): Promise<void> {
    const result = await this.#ft.settingsUpdate({ theme });
    if (result.ok) {
      this.settings = result.value;
      applyTheme(result.value.theme);
    }
  }

  /**
   * ファイル一覧(center)と差分(diff)の比率の永続化。
   * SettingsStore.update() は浅いマージなので、paneWidths は他フィールドも含めて送る
   * （centerRatio だけ送ると left/center が既定値に戻ってしまう）。
   */
  async setCenterRatio(ratio: number): Promise<void> {
    if (this.settings === null) return;
    const clamped = Math.min(0.9, Math.max(0.1, ratio));
    const result = await this.#ft.settingsUpdate({
      paneWidths: { ...this.settings.paneWidths, centerRatio: clamped },
    });
    if (result.ok) this.settings = result.value;
  }

  /**
   * ブランチペイン幅の永続化。
   * SettingsStore.update() は浅いマージなので、paneWidths は他フィールドも含めて送る
   * （left だけ送ると center/centerRatio が既定値に戻ってしまう）。
   */
  async setLeftWidth(px: number): Promise<void> {
    if (this.settings === null) return;
    const clamped = Math.min(1200, Math.max(120, Math.round(px)));
    const result = await this.#ft.settingsUpdate({
      paneWidths: { ...this.settings.paneWidths, left: clamped },
    });
    if (result.ok) this.settings = result.value;
  }

  /** ブランチペインの ローカル/リモート 分割高さの永続化。 */
  async setBranchLocalHeight(px: number): Promise<void> {
    if (this.settings === null) return;
    const clamped = Math.min(4000, Math.max(80, Math.round(px)));
    const result = await this.#ft.settingsUpdate({ branchLocalHeight: clamped });
    if (result.ok) this.settings = result.value;
  }

  /** ブランチペインの折り畳み状態の永続化。 */
  async setBranchPaneCollapsed(collapsed: boolean): Promise<void> {
    const result = await this.#ft.settingsUpdate({ branchPaneCollapsed: collapsed });
    if (result.ok) this.settings = result.value;
  }

  /** 実行ログパネルの高さの永続化。 */
  async setCommandLogHeight(px: number): Promise<void> {
    if (this.settings === null) return;
    const clamped = Math.min(800, Math.max(120, Math.round(px)));
    const result = await this.#ft.settingsUpdate({ commandLogHeight: clamped });
    if (result.ok) this.settings = result.value;
  }

  /** WorkingTreePane の ステージ済み/変更 分割高さの永続化。 */
  async setStagedHeight(px: number): Promise<void> {
    if (this.settings === null) return;
    const clamped = Math.min(4000, Math.max(80, Math.round(px)));
    const result = await this.#ft.settingsUpdate({ stagedHeight: clamped });
    if (result.ok) this.settings = result.value;
  }

  async setRefocusUpdateMode(mode: SettingsDto['refocusUpdateMode']): Promise<void> {
    const result = await this.#ft.settingsUpdate({ refocusUpdateMode: mode });
    if (result.ok) this.settings = result.value;
  }

  dismissFocusRefreshPrompt(): void {
    this.focusRefreshPrompt = null;
  }

  async acceptFocusRefreshPrompt(): Promise<void> {
    this.focusRefreshPrompt = null;
    await this.refresh('full');
  }

  // ---------------------------------------------------------------- 書き込み操作

  stage(target: OperationTargetDto): Promise<void> {
    return this.#operate(() => this.#ft.stage(this.#id(), target));
  }

  unstage(target: OperationTargetDto): Promise<void> {
    return this.#operate(() => this.#ft.unstage(this.#id(), target));
  }

  /**
   * ファイル一覧の行をダブルクリックしたときの、ステージ⇄アンステージの切替。
   *
   * ブラウザは同じ要素で click, click, dblclick の順に発火するため、dblclick が届く時点で
   * 既に2回の click（=onselect）が処理済みで、this.selected はこのファイルの現在の staged
   * 値を指している。reloadActive() の #stillPresent() が移動後の正しいセクションを見るように、
   * 呼び出し前に selected を反転させておく。
   */
  async toggleStage(file: SelectedFile): Promise<void> {
    this.selected = { path: file.path, staged: !file.staged };
    const target: OperationTargetDto = { kind: 'paths', paths: [file.path] };
    if (file.staged) await this.unstage(target);
    else await this.stage(target);
  }

  discard(target: OperationTargetDto): Promise<void> {
    return this.#operate(
      (confirmed) => this.#ft.discard(this.#id(), target, confirmed),
      () => this.#operate(() => this.#ft.discard(this.#id(), target, true)),
    );
  }

  deleteUntracked(target: OperationTargetDto): Promise<void> {
    return this.#operate(
      (confirmed) => this.#ft.deleteUntracked(this.#id(), target, confirmed),
      () => this.#operate(() => this.#ft.deleteUntracked(this.#id(), target, true)),
    );
  }

  async commit(): Promise<void> {
    const message = this.commitMessage;
    const amend = this.amend;
    const clear = (): void => {
      this.commitMessage = '';
      this.amend = false;
    };
    await this.#operate(
      (confirmed) => this.#ft.commit(this.#id(), { message, amend }, confirmed),
      () => this.#operate(() => this.#ft.commit(this.#id(), { message, amend }, true), undefined, clear),
      clear,
    );
  }

  /** ブランチのダブルクリックによる切替。確認不要（決定: ブランチ移動は無確認）。 */
  switchBranch(branchName: string): Promise<void> {
    return this.#operate(() => this.#ft.branchSwitch(this.#id(), branchName));
  }

  openCreateBranch(): void {
    if (this.currentBranch === null) return;
    this.createBranchOpen = true;
  }

  closeCreateBranch(): void {
    this.createBranchOpen = false;
  }

  /**
   * ブランチの新規作成(起点から分岐して切替まで)。確認不要・push はしない。
   * 成功時だけ onSuccess を呼ぶ(呼び出し元はこれでダイアログを閉じるかどうかを判断する)。
   */
  createBranch(name: string, startPoint: string, onSuccess?: () => void): Promise<void> {
    return this.#operate(
      () => this.#ft.branchCreate(this.#id(), { name, startPoint }),
      undefined,
      onSuccess,
    );
  }

  dismissError(): void {
    this.error = null;
  }

  cancelConfirmation(): void {
    this.pendingConfirmation = null;
  }

  async acceptConfirmation(): Promise<void> {
    const pending = this.pendingConfirmation;
    this.pendingConfirmation = null;
    if (pending !== null) await pending.retry();
  }

  // ---------------------------------------------------------------- 内部

  #id(): string {
    const id = this.activeId;
    if (id === null) throw new Error('アクティブなリポジトリがありません');
    return id;
  }

  /**
   * 書き込み操作の共通処理。
   * main が 'needs-confirmation' で拒否したら確認ダイアログを出し、承認後に再実行する。
   * 確認の判定は renderer では行わない（決定 16）。
   */
  async #operate<T>(
    call: (confirmed?: boolean) => Promise<Result<T>>,
    retry?: () => Promise<void>,
    onSuccess?: () => void,
  ): Promise<void> {
    await this.#run(async () => {
      const result = await call();
      if (!result.ok) {
        const needsConfirm =
          result.error.kind === 'needs-confirmation' &&
          result.error.confirmation !== undefined &&
          retry !== undefined;
        if (needsConfirm && result.error.confirmation !== undefined && retry !== undefined) {
          this.pendingConfirmation = { confirmation: result.error.confirmation, retry };
          return;
        }
        this.error = result.error;
        return;
      }
      onSuccess?.();
      await this.reloadActive();
    });
  }

  async #run(body: () => Promise<void>): Promise<void> {
    this.busy = true;
    try {
      await body();
    } catch (err) {
      this.error = { kind: 'internal', message: err instanceof Error ? err.message : '不明なエラー' };
    } finally {
      this.busy = false;
    }
  }

  #check<T>(result: Result<T>): result is { ok: true; value: T } {
    if (result.ok) return true;
    this.error = result.error;
    return false;
  }

  #stillPresent(file: SelectedFile): boolean {
    const section = file.staged ? this.staged : this.changes;
    return section.entries.some((e) => e?.path === file.path);
  }

  #saveCache(): void {
    if (this.activeId === null) return;
    this.#cache.set(this.activeId, {
      summary: this.summary,
      staged: this.staged,
      changes: this.changes,
      selected: this.selected,
      branches: this.branches,
    });
  }

  #clearActive(): void {
    this.summary = null;
    this.staged = emptySection();
    this.changes = emptySection();
    this.branches = [];
    this.selected = null;
    this.diff = null;
    this.commitMessage = '';
    this.amend = false;
  }
}

export const app = new AppState(ft);
