import type { FeatherTreeBridge } from '@feathertree/ipc';
import type {
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

  selected = $state<SelectedFile | null>(null);
  diff = $state<FileDiffDto | null>(null);
  diffLoading = $state(false);

  commitMessage = $state('');
  amend = $state(false);

  busy = $state(false);
  error = $state<FtErrorDto | null>(null);
  pendingConfirmation = $state<PendingConfirmation | null>(null);

  commandLog = $state<CommandLogEntryDto[]>([]);
  showCommandLog = $state(false);

  /** セッションごとの状態。タブ切替で一覧を取り直さないためのキャッシュ。 */
  readonly #cache = new SvelteMap<
    string,
    { summary: StatusSummaryDto | null; staged: Section; changes: Section; selected: SelectedFile | null }
  >();

  get activeSession(): SessionDto | null {
    return this.sessions.find((s) => s.id === this.activeId) ?? null;
  }

  get canCommit(): boolean {
    if (this.busy || this.activeId === null) return false;
    if (this.commitMessage.trim().length === 0) return false;
    return this.amend || (this.summary?.counts.staged ?? 0) > 0;
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
      if (this.activeId !== null) await this.reloadActive();
    }

    // main 側の自動更新（ウィンドウ復帰時）を受けて表示を合わせる
    this.#ft.onSessionChanged((event) => {
      if (event.sessionId !== this.activeId) return;
      void this.reloadActive();
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
      await this.reloadActive();
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
      await this.reloadActive();
      return;
    }
    this.summary = cached.summary;
    this.staged = cached.staged;
    this.changes = cached.changes;
    this.selected = cached.selected;
    this.diff = null;
    if (cached.selected !== null) await this.loadDiff(cached.selected);
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
    if (this.activeId !== null) await this.reloadActive();
  }

  /** 手動更新。決定 14 のもう一方の入口。 */
  async refresh(scope: 'status' | 'full' = 'full'): Promise<void> {
    const id = this.activeId;
    if (id === null) return;
    await this.#run(async () => {
      const result = await this.#ft.sessionRefresh(id, scope);
      if (!this.#check(result)) return;
      await this.reloadActive();
    });
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

  // ---------------------------------------------------------------- 書き込み操作

  stage(target: OperationTargetDto): Promise<void> {
    return this.#operate(() => this.#ft.stage(this.#id(), target));
  }

  unstage(target: OperationTargetDto): Promise<void> {
    return this.#operate(() => this.#ft.unstage(this.#id(), target));
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
    });
  }

  #clearActive(): void {
    this.summary = null;
    this.staged = emptySection();
    this.changes = emptySection();
    this.selected = null;
    this.diff = null;
    this.commitMessage = '';
    this.amend = false;
  }
}

export const app = new AppState(ft);
