import type { FeatherTreeBridge } from '@feathertree/ipc';
import type {
  BranchDto,
  CloneRequest,
  CommandLogEntryDto,
  CommandStartEvent,
  CommitFileChangeDto,
  CommitSummaryDto,
  ConfirmationDto,
  EnvironmentDto,
  FileDiffDto,
  FileEntryDto,
  HunkSelectionDto,
  FtErrorDto,
  OperationTargetDto,
  Result,
  SessionDto,
  SettingsDto,
  StatusGroupDto,
  StatusSummaryDto,
} from '@feathertree/ipc';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { ft } from '../bridge.js';
import { applyTheme } from './theme.js';
import { nextSelectionAfterRemoval } from './selection.js';

/** ブランチペインの展開状態が無いときに返す共通の空配列（毎回作り直さない）。 */
const EMPTY_EXPANDED: readonly string[] = [];

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
  /** リモート名の一覧。プッシュ／フェッチ先の選択に使う。 */
  remotes = $state<readonly string[]>([]);

  /**
   * 実行中の git コマンド（決定 26）。末尾が最新。
   *
   * 並行して走ることがある（diff を読みながら status を取り直す等）ので配列で持つ。
   * 終了通知が来たものから取り除く。
   */
  runningCommands = $state<readonly CommandStartEvent[]>([]);

  /**
   * 一覧を読み込んでいる最中のタブ。
   *
   * リポジトリを開くときはタブを先に立てるので（openRepository）、
   * 中身が空のタブが先に現れる。その間タブに回転印を出して、止まっていない
   * ことを示す。複数タブを並行して読み込むことがあるので集合で持つ。
   */
  readonly loadingSessions = new SvelteSet<string>();

  selected = $state<SelectedFile | null>(null);
  diff = $state<FileDiffDto | null>(null);
  diffLoading = $state(false);

  /* ---------------------------------------------------------------- コミットログモード（決定 27） */

  /** 取得済みのコミット。新しい順。追加ページは末尾に足す（#20 を skip 付きで呼ぶ）。 */
  commits = $state<readonly CommitSummaryDto[]>([]);
  logLoading = $state(false);
  /** これ以上のページが無い（最後の応答が logPageSize 未満だった）。 */
  logComplete = $state(false);
  /** 選択中のコミットの oid。 */
  selectedCommit = $state<string | null>(null);
  commitFiles = $state<readonly CommitFileChangeDto[]>([]);
  commitFilesLoading = $state(false);
  /** コミット詳細「変更」タブで選択中のファイル。 */
  selectedCommitPath = $state<string | null>(null);
  commitDiff = $state<FileDiffDto | null>(null);
  commitDiffLoading = $state(false);
  commitDetailTab = $state<'info' | 'changes'>('info');

  /**
   * コミット関係の要求の世代番号。#diffSeq と同じ理由（古い応答で新しい選択を上書きしない）。
   * 描画に使わないので $state にしない。
   */
  #commitFilesSeq = 0;
  #commitDiffSeq = 0;

  /**
   * diff 要求の世代番号。$state にしない（描画に使わないため）。
   *
   * diffGet は ipcRenderer.invoke なので途中で止められない。古い応答が後から
   * 届いて新しい選択の diff を上書きしないよう、最後に投げた要求だけを採る。
   */
  #diffSeq = 0;

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

  /**
   * プッシュのダイアログ。
   * 開くボタンはツールバー段にあるが、ダイアログ自体は App.svelte の最上位に置く
   * （createBranchOpen と同じ理由）。
   */
  pushDialogOpen = $state(false);

  /**
   * 「リポジトリを開く」のポップアップ（ローカル／クローンを選ばせる）の表示位置。null なら出していない。
   * 押す口は 2 つ（初期画面のボタンとタブ段の「＋」）あるが、メニューは App.svelte の最上位に 1 つだけ置く
   * （タブ段はドラッグ領域かつ横スクロールの器なので、その中に出すとクリックが吸われたり切れたりする）。
   */
  openRepoMenu = $state<{ x: number; y: number } | null>(null);

  /** クローンのダイアログ。置き場所は createBranchOpen と同じ理由で App.svelte の最上位。 */
  cloneDialogOpen = $state(false);
  /**
   * 最終確認中のクローン要求。null なら確認を出していない（入力ダイアログを出している）。
   * 実行とクローン中の進捗表示も確認ダイアログ（CloneConfirmDialog）が受け持つ。
   */
  cloneConfirm = $state<CloneRequest | null>(null);
  /** クローン実行中。この間はダイアログを閉じさせない（キャンセルは未実装）。 */
  cloning = $state(false);
  /** クローンの最新の進捗行（git の stderr 1 行）。 */
  cloneProgress = $state<string | null>(null);

  /** セッションごとの状態。タブ切替で一覧を取り直さないためのキャッシュ。 */
  readonly #cache = new SvelteMap<
    string,
    {
      summary: StatusSummaryDto | null;
      staged: Section;
      changes: Section;
      selected: SelectedFile | null;
      branches: readonly BranchDto[];
      remotes: readonly string[];
      commits: readonly CommitSummaryDto[];
      logComplete: boolean;
      selectedCommit: string | null;
      commitFiles: readonly CommitFileChangeDto[];
      selectedCommitPath: string | null;
      commitDiff: FileDiffDto | null;
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

  /**
   * ブランチペインで展開中のフォルダ（アクティブなリポジトリの分だけ）。
   * 既定は全折りたたみなので、設定には「開いている側」を保存している。
   */
  get branchExpanded(): readonly string[] {
    const root = this.activeSession?.root ?? null;
    if (root === null || this.settings === null) return EMPTY_EXPANDED;
    return this.settings.branchExpanded[root] ?? EMPTY_EXPANDED;
  }

  /** 今いるブランチ名。detached HEAD やリポジトリ未取得では null（作成の起点に使えない）。 */
  get currentBranch(): string | null {
    const head = this.summary?.head ?? null;
    if (head === null || head.detached) return null;
    return head.branch;
  }

  /**
   * HEAD が指しているコミットの件名。無ければ null。
   *
   * 出すのはリポジトリタブ（決定 24）だけ。
   *
   * 出所は取得済みのブランチ一覧（対応表 #3 の `%(contents:subject)`）なので git は増えない。
   * **どのブランチかは一覧の `isHead` ではなく status 由来の `currentBranch` で決める。**
   * ブランチ切替・作成の直後は一覧を取り直さない（#12 → #2 / #14 → #2）ので、
   * 一覧側の `isHead` は古いままになる。
   */
  get headSubject(): string | null {
    const head = this.summary?.head ?? null;
    if (head === null || head.oid === null) return null;

    const current = this.currentBranch;
    if (current !== null) {
      return this.branches.find((b) => !b.isRemote && b.shortName === current)?.subject ?? null;
    }
    // detached HEAD。`*` 印の付く ref が無いので oid の一致で探す
    return this.branches.find((b) => b.oid === head.oid)?.subject ?? null;
  }

  /**
   * 今アクティブなタブで実行中のコマンドのうち、最後に始まったもの。
   * コマンドバーはこれ 1 つだけを映す（複数を並べても読めない）。
   */
  get runningCommand(): CommandStartEvent | null {
    for (let i = this.runningCommands.length - 1; i >= 0; i -= 1) {
      const event = this.runningCommands[i];
      if (event !== undefined && event.sessionId === this.activeId) return event;
    }
    return null;
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

    /*
     * 実行中の git コマンド（決定 26）。
     * ここでセッションを絞り込まないのは、終了通知を取りこぼすと配列に残り続けるため。
     * 全タブ分を溜めて、表示する段（runningCommand）で絞る。
     */
    this.#ft.onCommandStart((event) => {
      this.runningCommands = [...this.runningCommands, event];
    });
    this.#ft.onCommandEnd((event) => {
      this.runningCommands = this.runningCommands.filter((c) => c.opId !== event.opId);
    });

    /*
     * 進捗行（docs/01-architecture.md 6 章）。今の送り手はクローンだけで、sessionId は null。
     * クローン中でなければ捨てる（終わった後に遅れて届いた行で表示を書き戻さない）。
     */
    this.#ft.onProgress((event) => {
      if (event.sessionId !== null || !this.cloning) return;
      this.cloneProgress = event.line;
    });
  }

  /** タブが読み込み中か。回転印を出すのはこのタブだけ。 */
  isLoading(id: string): boolean {
    return this.loadingSessions.has(id);
  }

  /**
   * リポジトリを開く。**タブを先に立ててから読み込む**（2 段階）。
   *
   * 1 段目 sessionPickAndCreate は対応表 #1 だけなのですぐ返る。そこでタブを足して
   * アクティブにしてから、2 段目 sessionLoad（#2 → #3 → #4）を投げる。
   *
   * 順序を逆にしてはいけない。読み込みが終わるまでタブが現れないと、
   * 巨大リポジトリでは数十秒のあいだ画面が前のタブのまま動かず、
   * コマンドバーも（実行中のセッションがアクティブでないため）何も映さない。
   * アプリが固まったようにしか見えなくなる。
   */
  async openRepository(): Promise<void> {
    const picked = await this.#ft.sessionPickAndCreate();
    if (!this.#check(picked) || picked.value === null) return;
    await this.#addOpenedTab(picked.value);
  }

  /* ---------------------------------------------------------------- 開く口のポップアップとクローン */

  showOpenRepositoryMenu(x: number, y: number): void {
    this.openRepoMenu = { x, y };
  }

  closeOpenRepositoryMenu(): void {
    this.openRepoMenu = null;
  }

  openCloneDialog(): void {
    this.cloneProgress = null;
    this.cloneConfirm = null;
    this.cloneDialogOpen = true;
  }

  /**
   * クローンの入力と確認をまとめて閉じる。
   * クローン中は閉じさせない。閉じても git は止まらず、終わったタブだけが突然現れることになるため。
   */
  closeCloneDialog(): void {
    if (this.cloning) return;
    this.cloneConfirm = null;
    this.cloneDialogOpen = false;
  }

  /** 入力ダイアログの「決定」。git はまだ動かさず、最終確認を出す。 */
  confirmClone(req: CloneRequest): void {
    this.cloneConfirm = req;
  }

  /** 確認から入力へ戻る（入力内容は入力ダイアログ側に残っている）。実行中は戻らない。 */
  backToCloneForm(): void {
    if (this.cloning) return;
    this.cloneConfirm = null;
  }

  /** 保存先（親フォルダ）の選択。キャンセルなら null。 */
  async pickCloneDirectory(): Promise<string | null> {
    const picked = await this.#ft.clonePickDirectory();
    if (!this.#check(picked)) return null;
    return picked.value;
  }

  /**
   * クローンしてタブを立てる（対応表 #37 → #1、その後 #2 〜 #4 は openRepository と同じ 2 段目）。
   * 成功時だけ onSuccess を呼ぶ。失敗したらダイアログを閉じず、エラー帯を見て入力を直させる。
   */
  async cloneRepository(req: CloneRequest, onSuccess?: () => void): Promise<void> {
    this.cloning = true;
    this.cloneProgress = null;
    let created: SessionDto | null = null;
    try {
      await this.#run(async () => {
        const result = await this.#ft.sessionCloneAndCreate(req);
        if (!this.#check(result)) return;
        created = result.value;
      });
    } finally {
      this.cloning = false;
    }
    if (created === null) return;
    onSuccess?.();
    await this.#addOpenedTab(created);
  }

  /**
   * 1 段目で立ったセッションをタブとして見せ、2 段目（sessionLoad）を投げる。
   * ローカルを開く経路とクローンの経路で共用する。
   */
  async #addOpenedTab(opened: SessionDto): Promise<void> {
    // 既に開いているリポジトリを選んだときはタブを増やさず、そのタブへ切り替える
    if (this.sessions.some((s) => s.id === opened.id)) {
      await this.activate(opened.id);
      return;
    }

    this.#saveCache();
    this.sessions = [...this.sessions, opened];
    this.activeId = opened.id;
    this.#clearActive();
    this.loadingSessions.add(opened.id);

    try {
      await this.#run(async () => {
        const loaded = await this.#ft.sessionLoad(opened.id);
        if (!this.#check(loaded)) return;
        // 読み込み中に別のタブへ移られていたら、そちらの表示を上書きしない
        if (this.activeId !== opened.id) return;
        await this.reloadAll();
      });
    } finally {
      this.loadingSessions.delete(opened.id);
    }
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
    this.remotes = cached.remotes;
    this.commits = cached.commits;
    this.logComplete = cached.logComplete;
    this.selectedCommit = cached.selectedCommit;
    this.commitFiles = cached.commitFiles;
    this.selectedCommitPath = cached.selectedCommitPath;
    this.commitDiff = cached.commitDiff;
    this.#invalidateDiff();
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
      /*
       * 履歴を見ているのに更新しても変わらない、では筋が通らないので取り直す。
       * 対応表の例外「『更新』ボタン（コミットログモード）: #2 → #3 → #20」。
       * **差分モードでは走らせない**（見えていないものを取り直さない）。
       */
      if (this.viewMode === 'log') await this.loadLog();
    });
  }

  /**
   * 表示物をすべて取り直す（更新ボタン・タブの切り替わり）。
   * 書き込み操作の後は main がブランチを取り直さないので、こちらではなく reloadActive を使う。
   */
  async reloadAll(): Promise<void> {
    await this.reloadActive();
    await this.reloadBranches();
    await this.reloadRemotes();
  }

  /** リモート名の取り直し。ブランチ一覧と同じく main のスナップショットを読むだけ。 */
  async reloadRemotes(): Promise<void> {
    const id = this.activeId;
    if (id === null) return;
    const result = await this.#ft.remoteList(id);
    if (result.ok) this.remotes = [...result.value];
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
      this.#invalidateDiff();
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
    const seq = (this.#diffSeq += 1);
    this.diffLoading = true;
    try {
      const result = await this.#ft.diffGet(id, file.path, file.staged);
      // 追い越された要求の応答は捨てる
      if (seq !== this.#diffSeq) return;
      this.diff = result.ok ? result.value : null;
    } finally {
      // 新しい要求が走っているなら、その読み込み表示を消さない
      if (seq === this.#diffSeq) this.diffLoading = false;
    }
  }

  /** 飛んでいる diff 要求を無効にしてから差分を消す。 */
  #invalidateDiff(): void {
    this.#diffSeq += 1;
    this.diff = null;
  }

  async reloadCommandLog(): Promise<void> {
    const result = await this.#ft.commandLogRecent(200);
    if (result.ok) this.commandLog = [...result.value];
  }

  // ---------------------------------------------------------------- コミットログモード（決定 27）

  /** 今のモード。設定に永続化してあるので、再起動しても履歴を読んでいた続きから開く。 */
  get viewMode(): 'diff' | 'log' {
    return this.settings?.viewMode ?? 'diff';
  }

  async setViewMode(mode: 'diff' | 'log'): Promise<void> {
    const result = await this.#ft.settingsUpdate({ viewMode: mode });
    if (result.ok) this.settings = result.value;
  }

  /**
   * 履歴をまだ一度も取っていなければ取る。コミットログモードのペインから呼ぶ。
   *
   * **モードに入った瞬間に初めて #20 が走る。** 差分モードでいる限り履歴は取らない
   * （見えていないもののために git を起動しない。docs/00-decisions.md「やらないこと」）。
   */
  async ensureLog(): Promise<void> {
    if (this.activeId === null || this.logLoading || this.commits.length > 0) return;
    await this.loadLog();
  }

  /** 履歴の取り直し（1 ページ目から）。選択していたコミットは消える。 */
  async loadLog(): Promise<void> {
    const id = this.activeId;
    if (id === null) return;
    this.logLoading = true;
    try {
      const result = await this.#ft.logGetPage(id, 0);
      if (id !== this.activeId) return;
      if (!this.#check(result)) return;
      this.#clearLog();
      this.commits = [...result.value];
      this.logComplete = result.value.length < this.#logPageSize();
    } finally {
      this.logLoading = false;
    }
  }

  /**
   * スクロールが末尾に届いたときの追加読み込み。
   * skip は取得済みの件数そのもの（#20 の --skip）。
   */
  async loadMoreLog(): Promise<void> {
    const id = this.activeId;
    if (id === null || this.logLoading || this.logComplete) return;
    const skip = this.commits.length;
    this.logLoading = true;
    try {
      const result = await this.#ft.logGetPage(id, skip);
      // 追い越し（タブを替えた・1 ページ目から取り直した）の応答は捨てる
      if (id !== this.activeId || this.commits.length !== skip) return;
      if (!result.ok) {
        this.error = result.error;
        return;
      }
      this.commits = [...this.commits, ...result.value];
      if (result.value.length < this.#logPageSize()) this.logComplete = true;
    } finally {
      this.logLoading = false;
    }
  }

  #logPageSize(): number {
    return this.settings?.logPageSize ?? 200;
  }

  /** コミットを選ぶ。変更ファイル一覧（#21）を 1 回だけ取る。 */
  async selectCommit(oid: string): Promise<void> {
    const id = this.activeId;
    if (id === null || this.selectedCommit === oid) return;

    this.selectedCommit = oid;
    // 前のコミットのファイル選択と差分は意味を持たない。飛んでいる要求ごと捨てる
    this.selectedCommitPath = null;
    this.#commitDiffSeq += 1;
    this.commitDiff = null;

    const seq = (this.#commitFilesSeq += 1);
    this.commitFilesLoading = true;
    try {
      const result = await this.#ft.commitGetFiles(id, oid);
      if (seq !== this.#commitFilesSeq) return;
      this.commitFiles = result.ok ? [...result.value] : [];
      if (!result.ok) this.error = result.error;
    } finally {
      if (seq === this.#commitFilesSeq) this.commitFilesLoading = false;
    }
  }

  /** コミット詳細「変更」タブでファイルを選ぶ。そのファイルの diff（#36）を取る。 */
  async selectCommitPath(path: string): Promise<void> {
    const id = this.activeId;
    const oid = this.selectedCommit;
    if (id === null || oid === null) return;

    this.selectedCommitPath = path;
    const seq = (this.#commitDiffSeq += 1);
    this.commitDiffLoading = true;
    try {
      const result = await this.#ft.commitGetDiff(id, oid, path);
      if (seq !== this.#commitDiffSeq) return;
      this.commitDiff = result.ok ? result.value : null;
      if (!result.ok) this.error = result.error;
    } finally {
      if (seq === this.#commitDiffSeq) this.commitDiffLoading = false;
    }
  }

  /** コミット詳細ペインの高さの永続化。 */
  async setLogDetailHeight(px: number): Promise<void> {
    const clamped = Math.min(2000, Math.max(120, Math.round(px)));
    const result = await this.#ft.settingsUpdate({ logDetailHeight: clamped });
    if (result.ok) this.settings = result.value;
  }

  /** 「変更」タブの左ファイルリスト幅の永続化。 */
  async setCommitFileListWidth(px: number): Promise<void> {
    const clamped = Math.min(1200, Math.max(120, Math.round(px)));
    const result = await this.#ft.settingsUpdate({ commitFileListWidth: clamped });
    if (result.ok) this.settings = result.value;
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

  /**
   * ブランチペインの展開状態の永続化（リポジトリごと）。
   *
   * SettingsStore.update() は浅いマージなので、辞書は全体を送る。
   * 使用中のリポジトリのキーを先頭に置き、上限（30 件）を超えたときに
   * 今開いているリポジトリの状態が切り捨てられないようにする。
   */
  async setBranchExpanded(paths: readonly string[]): Promise<void> {
    const root = this.activeSession?.root ?? null;
    if (root === null || this.settings === null) return;
    const rest: Record<string, readonly string[]> = { ...this.settings.branchExpanded };
    delete rest[root];
    const next = paths.length === 0 ? rest : { [root]: [...paths], ...rest };

    // 先に画面へ反映する。IPC の往復を待つと、main が重い git を抱えている間
    // クリックしても三角マークすら変わらず「無反応」に見える。
    const previous = this.settings.branchExpanded;
    this.settings = { ...this.settings, branchExpanded: next };

    const result = await this.#ft.settingsUpdate({ branchExpanded: next });
    if (result.ok) {
      this.settings = result.value;
      return;
    }
    // 保存できなかったら見た目も戻す。黙って捨てると原因が分からなくなる。
    if (this.settings !== null) {
      this.settings = { ...this.settings, branchExpanded: previous };
    }
    this.error = result.error;
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

  /** リポジトリタブに現在情報を出すかの永続化（決定 24）。 */
  async setTabShowCurrentInfo(show: boolean): Promise<void> {
    const result = await this.#ft.settingsUpdate({ tabShowCurrentInfo: show });
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
    this.#moveSelectionPastTarget(target, false);
    return this.#operate(() => this.#ft.stage(this.#id(), target));
  }

  unstage(target: OperationTargetDto): Promise<void> {
    this.#moveSelectionPastTarget(target, true);
    return this.#operate(() => this.#ft.unstage(this.#id(), target));
  }

  /**
   * ステージ／アンステージしたファイルは一覧から消えるので、その 1 行下
   * （無ければ 1 行上）へ選択を移す。連続して処理するときに手が止まらないようにする。
   *
   * 一覧が変わる**前**に次の行を決めておく必要があるので、操作を投げる直前に呼ぶ。
   * 全件操作（すべてステージ／すべて戻す）は移動先が無いので選択を解除する。
   *
   * @param staged 操作元がステージ済み側か。
   */
  #moveSelectionPastTarget(target: OperationTargetDto, staged: boolean): void {
    if (this.selected === null || this.selected.staged !== staged) return;

    if (target.kind !== 'paths') {
      // 範囲指定はセクションごと空になりうる。素直に選択を解除する
      this.selected = null;
      this.#invalidateDiff();
      return;
    }

    const section = staged ? this.staged : this.changes;
    const next = nextSelectionAfterRemoval(section.entries, target.paths);
    this.selected = next === null ? null : { path: next, staged };
    if (next === null) this.#invalidateDiff();
  }

  /**
   * ファイル一覧の行をダブルクリックしたときの、ステージ⇄アンステージの切替。
   *
   * ブラウザは同じ要素で click, click, dblclick の順に発火するため、dblclick が届く時点で
   * 既に2回の click（=onselect）が処理済みで、this.selected はこのファイルの現在の staged
   * 値を指している。移動先の決定は stage() / unstage() 側が行う。
   */
  async toggleStage(file: SelectedFile): Promise<void> {
    const target: OperationTargetDto = { kind: 'paths', paths: [file.path] };
    if (file.staged) await this.unstage(target);
    else await this.stage(target);
  }

  /**
   * hunk / 行単位のステージ（対応表 #33）。確認不要。
   * 同じファイルを見ながら残りを処理できるよう、選択は動かさない。
   */
  stageHunks(hunks: readonly HunkSelectionDto[]): Promise<void> {
    const path = this.selected?.path;
    if (path === undefined || hunks.length === 0) return Promise.resolve();
    return this.#operate(() => this.#ft.stageHunks(this.#id(), { path, hunks }));
  }

  /** hunk / 行単位のアンステージ（対応表 #34）。 */
  unstageHunks(hunks: readonly HunkSelectionDto[]): Promise<void> {
    const path = this.selected?.path;
    if (path === undefined || hunks.length === 0) return Promise.resolve();
    return this.#operate(() => this.#ft.unstageHunks(this.#id(), { path, hunks }));
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

  /**
   * コミット（対応表 #10 / #11）。
   *
   * 成功したときだけブランチ一覧も取り直す（例外「コミット後の反映: #10 → #2 → #3」）。
   * ahead が進むうえ、**HEAD の件名の出所が #3 しかない**ので、取り直さないと
   * リポジトリタブに 1 つ前の件名が残る。
   * 読むのは main のスナップショットなので、ここで git は増えない（#3 は main が済ませている）。
   */
  async commit(): Promise<void> {
    const message = this.commitMessage;
    const amend = this.amend;
    // 確認待ちで止まった場合は取り直さないよう、成功したことを onSuccess で拾う
    let committed = false;
    const clear = (): void => {
      this.commitMessage = '';
      this.amend = false;
      committed = true;
    };
    await this.#operate(
      (confirmed) => this.#ft.commit(this.#id(), { message, amend }, confirmed),
      async () => {
        await this.#operate(
          () => this.#ft.commit(this.#id(), { message, amend }, true),
          undefined,
          clear,
        );
        if (committed) await this.reloadBranches();
      },
      clear,
    );
    if (committed) await this.reloadBranches();
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

  /**
   * 現在のブランチへ branchName を取り込む。確認が必要（決定 16）。
   * 確認の判定は main が行うので、ここは needs-confirmation を受けて再送するだけ。
   */
  mergeBranch(branchName: string): Promise<void> {
    return this.#operate(
      (confirmed) => this.#ft.branchMerge(this.#id(), branchName, confirmed),
      () => this.#operate(() => this.#ft.branchMerge(this.#id(), branchName, true)),
    );
  }

  /**
   * OS 既定のアプリでファイルを開く。どのアプリで開くかは Windows の関連付けに任せる。
   *
   * リポジトリの状態は変わらないので、#operate ではなく軽い経路を使う
   * （成功のたびに一覧と差分を取り直すのは無駄。決定: アイドル時に git を起動しない）。
   */
  openFile(path: string): Promise<void> {
    return this.#run(async () => {
      this.#check(await this.#ft.shellOpenPath(this.#id(), path));
    });
  }

  /** エクスプローラでそのファイルを選択した状態で開く。状態は変わらない。 */
  showInFolder(path: string): Promise<void> {
    return this.#run(async () => {
      this.#check(await this.#ft.shellShowInFolder(this.#id(), path));
    });
  }

  /**
   * リポジトリを外部ターミナルで開く（決定 26）。
   * どこを開くかは main が決めるので、渡すのはセッション id だけ。
   * git を動かさないので openFile と同じ軽い経路を通す。
   */
  openTerminal(): Promise<void> {
    return this.#run(async () => {
      this.#check(await this.#ft.shellOpenTerminal(this.#id()));
    });
  }

  /*
   * リモート操作（対応表 #22〜#25）。3 つとも確認は不要（決定 16）。
   *
   * git の実行と main 側の取り直しは #operate が済ませるが、#operate 末尾の
   * reloadActive はブランチ一覧を含まない。リモート操作は必ず ahead/behind を
   * 動かすので、**ここだけは一覧も取り直す**（読むのは main のスナップショットで git は動かない）。
   */

  async fetch(remote: string): Promise<void> {
    await this.#operate(() => this.#ft.remoteFetch(this.#id(), remote));
    await this.reloadBranches();
  }

  async pull(): Promise<void> {
    await this.#operate(() => this.#ft.remotePull(this.#id()));
    await this.reloadBranches();
  }

  openPushDialog(): void {
    if (this.activeId === null || this.remotes.length === 0) return;
    this.pushDialogOpen = true;
  }

  closePushDialog(): void {
    this.pushDialogOpen = false;
  }

  /**
   * setUpstream が真なら対応表 #25（上流を張りながらプッシュ）。
   * 成功時だけ onSuccess を呼ぶ（失敗したらダイアログを閉じず、条件を変えて再試行させる）。
   */
  async push(
    remote: string,
    branch: string,
    setUpstream: boolean,
    onSuccess?: () => void,
  ): Promise<void> {
    await this.#operate(
      () => this.#ft.remotePush(this.#id(), { remote, branch, setUpstream }),
      undefined,
      onSuccess,
    );
    await this.reloadBranches();
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
      remotes: this.remotes,
      commits: this.commits,
      logComplete: this.logComplete,
      selectedCommit: this.selectedCommit,
      commitFiles: this.commitFiles,
      selectedCommitPath: this.selectedCommitPath,
      commitDiff: this.commitDiff,
    });
  }

  #clearActive(): void {
    this.summary = null;
    this.staged = emptySection();
    this.changes = emptySection();
    this.branches = [];
    this.remotes = [];
    this.selected = null;
    this.#invalidateDiff();
    this.#clearLog();
    this.commitMessage = '';
    this.amend = false;
  }

  /** コミットログモードの表示物を捨てる。飛んでいる要求も無効にする。 */
  #clearLog(): void {
    this.commits = [];
    this.logComplete = false;
    this.selectedCommit = null;
    this.#commitFilesSeq += 1;
    this.commitFiles = [];
    this.selectedCommitPath = null;
    this.#commitDiffSeq += 1;
    this.commitDiff = null;
    this.commitDetailTab = 'info';
  }
}

export const app = new AppState(ft);
