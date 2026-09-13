import type { FeatherTreeBridge } from '@feathertree/ipc';
import type {
  BranchDto,
  CloneOutcomeDto,
  CloneRequest,
  CloneStageDto,
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
import { tick } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { ft } from '../bridge.js';
import { applyTheme } from './theme.js';
import { nextSelectionAfterRemoval } from './selection.js';
import { TabActivity } from './tabActivity.js';

/** ブランチペインの展開状態が無いときに返す共通の空配列（毎回作り直さない）。 */
const EMPTY_EXPANDED: readonly string[] = [];

/** 1 セクションが一度に取得する件数。仮想化しているので画面分 + 余裕で足りる。 */
const PAGE_LIMIT = 200;

/** 実行ログを renderer に持つ件数。main の CommandLog の保持数（500）に合わせる。 */
const COMMAND_LOG_LIMIT = 500;

/**
 * タブの読み込み帯の対象にしない実行（ラベルの先頭語）。
 *
 * どれも選択やスクロールに伴う読み取りで、タブに出ている状態は変わらない。
 * 高頻度なので、拾うとファイルを選ぶたびに帯が出入りする。
 * 除外リストにしてあるのは、状態を変える git を将来足したときに書き足し忘れても
 * 「帯が出ない」失敗にならないようにするため（逆の失敗＝ちらつきは目で気づける）。
 * `read-untracked` は git ではないが、track() を通るので同じラベル体系に載っている。
 */
const VIEW_ONLY_COMMANDS: ReadonlySet<string> = new Set(['diff', 'read-untracked', 'show', 'log']);

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
  /** タブの読み込み帯（発動条件は tabActivity.ts）。 */
  readonly #tabActivity: TabActivity;

  /** tabActivity を差し替えられるのはテストのため（時間の規則を 0 にして同期的に確かめる）。 */
  constructor(bridge: FeatherTreeBridge, options: { readonly tabActivity?: TabActivity } = {}) {
    this.#ft = bridge;
    this.#tabActivity = options.tabActivity ?? new TabActivity();
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

  /** 実行ログ（全タブ分、新しい順）。main の追記通知（onCommandLogged）で増える。 */
  commandLog = $state<CommandLogEntryDto[]>([]);
  showCommandLog = $state(false);
  /**
   * 実行ログの表示範囲。tab はアクティブなタブの実行だけ、all はすべて
   * （クローンのようにタブに属さない実行や、閉じたタブの実行も含む）。
   */
  commandLogScope = $state<'tab' | 'all'>('tab');

  /** パネルに出す実行ログ。 */
  get visibleCommandLog(): CommandLogEntryDto[] {
    if (this.commandLogScope === 'all') return this.commandLog;
    const id = this.activeId;
    if (id === null) return [];
    return this.commandLog.filter((e) => e.sessionId === id);
  }

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
  /** クローン実行中。この間はダイアログを閉じさせない（止めるときは cancelClone）。 */
  cloning = $state(false);
  /** 中止を要求して、main の応答を待っている。 */
  cancellingClone = $state(false);
  /** クローンの段階表。実行中は main から届いたもの、終わったら結果の最終形。null なら未実行。 */
  cloneStages = $state<readonly CloneStageDto[] | null>(null);
  /** クローンの結果。null なら実行前か実行中。完了してもダイアログは自動では閉じない（決定 9）。 */
  cloneOutcome = $state<CloneOutcomeDto | null>(null);

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
      const id = event.sessionId;
      void this.#updating(id, () => this.#reflect(id, () => this.reloadActive()));
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
      this.#syncGitActivity(event.sessionId);
    });
    this.#ft.onCommandEnd((event) => {
      // 終了通知は opId しか持たないので、取り除く前にどのタブのものかを引いておく
      const ended = this.runningCommands.find((c) => c.opId === event.opId);
      this.runningCommands = this.runningCommands.filter((c) => c.opId !== event.opId);
      if (ended !== undefined) this.#syncGitActivity(ended.sessionId);
    });

    /*
     * 実行ログの追記。取り直しを操作の後に頼ると、差分の表示・履歴の読み込み・タブが無いときの
     * クローンなどが古いまま残るので、増えた分を main から受け取る。
     * 一覧の取り直し（reloadCommandLog）と行き違っても seq で重複を捨てる。
     */
    this.#ft.onCommandLogged((entry) => {
      if (this.commandLog.some((e) => e.seq === entry.seq)) return;
      this.commandLog = [entry, ...this.commandLog].slice(0, COMMAND_LOG_LIMIT);
    });

    /*
     * クローンの段階表（docs/01-architecture.md 6 章）。main で 200ms に間引かれて届く。
     * クローン中でなければ捨てる（終わった後に遅れて届いた行で表示を書き戻さない）。
     */
    this.#ft.onCloneProgress((event) => {
      if (!this.cloning) return;
      this.cloneStages = event.stages;
    });
  }

  /**
   * このタブに読み込み帯を出すか（決定 26）。
   * 意味は「このタブに出ている内容は古く、まもなく変わる」。発動条件は tabActivity.ts。
   */
  isUpdating(id: string): boolean {
    return this.#tabActivity.isShown(id);
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
    this.#resetClone();
    this.cloneDialogOpen = true;
  }

  /**
   * クローンの入力と確認をまとめて閉じる。
   * クローン中は閉じさせない。閉じても git は止まらず、終わったタブだけが突然現れることになるため。
   */
  closeCloneDialog(): void {
    if (this.cloning) return;
    this.#resetClone();
    this.cloneDialogOpen = false;
  }

  /** 入力ダイアログの「決定」。git はまだ動かさず、最終確認を出す。 */
  confirmClone(req: CloneRequest): void {
    this.cloneConfirm = req;
  }

  /**
   * 確認から入力へ戻る（入力内容は入力ダイアログ側に残っている）。
   * 実行中は戻らない。終わった後は、クローンできなかった（failed）ときだけ戻れる
   * ——タブが立った後に入力を直して再実行すると、同じ場所へのクローンになって必ず失敗するため。
   */
  backToCloneForm(): void {
    if (this.cloning) return;
    if (this.cloneOutcome !== null && this.cloneOutcome.result !== 'failed') return;
    this.#resetClone();
  }

  #resetClone(): void {
    this.cloneConfirm = null;
    this.cloneStages = null;
    this.cloneOutcome = null;
    this.cancellingClone = false;
  }

  /** 保存先（親フォルダ）の選択。キャンセルなら null。 */
  async pickCloneDirectory(): Promise<string | null> {
    const picked = await this.#ft.clonePickDirectory();
    if (!this.#check(picked)) return null;
    return picked.value;
  }

  /**
   * クローンしてタブを立てる（対応表 #37 → #1、その後 #2 〜 #4 は openRepository と同じ 2 段目）。
   *
   * ダイアログは閉じない（完了表示・ヒント・生ログを読ませるため。決定 9）。
   * git の失敗や中止は結果（cloneOutcome）で届き、エラー帯には出さない。エラー帯に出るのは
   * 入力検証の違反（ok: false）だけ。クローン自体ができていれば、失敗・中止でもタブを立てる。
   *
   * `#run`（busy）は使わない。大規模クローンは数時間かかりうるので、その間アプリ全体を busy にしない
   * （確認ダイアログがモーダルなので、他の操作はどのみち触れない）。
   */
  async cloneRepository(req: CloneRequest): Promise<void> {
    if (this.cloning) return;
    this.cloning = true;
    this.cancellingClone = false;
    this.cloneStages = null;
    this.cloneOutcome = null;
    let outcome: CloneOutcomeDto | null = null;
    try {
      /*
       * 送る前に普通のオブジェクトへ組み直す。確認ダイアログは $state に入った cloneConfirm（Proxy）を
       * そのまま渡してくるが、Proxy は IPC の structured clone を通らず
       * 「An object could not be cloned.」で git を起動する前に落ちる。
       */
      const plain: CloneRequest = { url: req.url, parentDir: req.parentDir, name: req.name, mode: req.mode };
      const result = await this.#ft.sessionCloneAndCreate(plain);
      if (!this.#check(result)) return;
      outcome = result.value;
      this.cloneOutcome = outcome;
      // 結果の段階表が最終形。git を走らせなかった場合（既存タブ・git 未導入）は空なので、届いていた表を残す
      if (outcome.stages.length > 0) this.cloneStages = outcome.stages;
    } catch (err) {
      this.error = { kind: 'internal', message: err instanceof Error ? err.message : '不明なエラー' };
    } finally {
      this.cloning = false;
      this.cancellingClone = false;
    }
    if (outcome !== null && outcome.session !== null) await this.#addOpenedTab(outcome.session);
  }

  /** 実行中のクローンを中止する。結果は cloneRepository の戻り（cancelled）で届く。 */
  async cancelClone(): Promise<void> {
    if (!this.cloning || this.cancellingClone) return;
    this.cancellingClone = true;
    this.#check(await this.#ft.cloneCancel());
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

    // 中身がまだ無いタブなので、読み込み帯は遅延なしで出す
    await this.#run(() =>
      this.#updating(
        opened.id,
        async () => {
          const loaded = await this.#ft.sessionLoad(opened.id);
          if (!this.#check(loaded)) return;
          await this.#reflect(opened.id, () => this.reloadAll());
        },
        true,
      ),
    );
  }

  /**
   * タブ切替。読み込み済みのタブは、一覧の取り直しをせずキャッシュから復元する。
   *
   * キャッシュが無いタブ（復元直後でまだ読み込んでいない・操作中に離れて捨てた）は
   * **先に切り替えてから読み込む**。main は sessionActivate の中で #2 〜 #4 を走らせるので、
   * 応答を待ってから activeId を移すと、その間の git がコマンドバーに映らず、
   * 画面も前のタブのまま固まって見える（リポジトリを開くときと同じ理由）。
   */
  async activate(id: string): Promise<void> {
    if (id === this.activeId) return;
    this.#saveCache();

    const cached = this.#cache.get(id);
    if (cached === undefined) {
      this.activeId = id;
      this.#clearActive();
      // 中身がまだ無いタブなので、読み込み帯は遅延なしで出す
      await this.#updating(
        id,
        async () => {
          const result = await this.#ft.sessionActivate(id);
          if (!this.#check(result)) return;
          await this.#reflect(id, () => this.reloadAll());
        },
        true,
      );
      return;
    }

    const result = await this.#ft.sessionActivate(id);
    if (!this.#check(result)) return;

    this.activeId = id;
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
    this.#tabActivity.forget(id);

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
    await this.#run(() =>
      this.#updating(id, async () => {
        const result = await this.#ft.sessionRefresh(id, scope);
        if (!this.#check(result)) return;
        await this.#reflect(id, async () => {
          await this.reloadAll();
          /*
           * 履歴を見ているのに更新しても変わらない、では筋が通らないので取り直す。
           * 対応表の例外「『更新』ボタン（コミットログモード）: #2 → #3 → #20」。
           * **差分モードでは走らせない**（見えていないものを取り直さない）。
           */
          if (this.viewMode === 'log' && this.activeId === id) await this.loadLog();
        });
      }),
    );
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
    // 待っている間に別のタブへ移られていたら、そちらの表示を上書きしない
    if (result.ok && id === this.activeId) this.remotes = [...result.value];
  }

  /** ブランチ一覧の取り直し。main のスナップショットを読むだけで git は動かない。 */
  async reloadBranches(): Promise<void> {
    const id = this.activeId;
    if (id === null) return;
    const result = await this.#ft.branchList(id);
    // 待っている間に別のタブへ移られていたら、そちらの表示を上書きしない
    if (result.ok && id === this.activeId) this.branches = [...result.value];
  }

  async reloadActive(): Promise<void> {
    const id = this.activeId;
    if (id === null) return;

    const [summary, staged, changes] = await Promise.all([
      this.#ft.statusGetSummary(id),
      this.#ft.statusGetPage(id, { offset: 0, limit: PAGE_LIMIT, filter: { group: 'staged' } }),
      this.#ft.statusGetPage(id, { offset: 0, limit: PAGE_LIMIT, filter: { group: 'changes' } }),
    ]);

    // 待っている間に別のタブへ移られていたら、そちらの表示を上書きしない
    if (id !== this.activeId) return;

    if (summary.ok) this.summary = summary.value;
    if (staged.ok) this.staged = { entries: [...staged.value.entries], total: staged.value.filteredTotal };
    if (changes.ok) this.changes = { entries: [...changes.value.entries], total: changes.value.filteredTotal };

    if (this.selected !== null && !this.#stillPresent(this.selected)) {
      this.selected = null;
      this.#invalidateDiff();
    } else if (this.selected !== null) {
      await this.loadDiff(this.selected);
    }
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

  /** 実行ログを main の保持分（最大 500 件）から取り直す。パネルを開いたときに呼ぶ。 */
  async reloadCommandLog(): Promise<void> {
    const result = await this.#ft.commandLogRecent(COMMAND_LOG_LIMIT);
    if (result.ok) this.commandLog = [...result.value];
  }

  /** 実行ログパネルの開閉。開くときは、通知を受け取る前の分も含めて取り直す。 */
  async toggleCommandLog(): Promise<void> {
    this.showCommandLog = !this.showCommandLog;
    if (this.showCommandLog) await this.reloadCommandLog();
  }

  setCommandLogScope(scope: 'tab' | 'all'): void {
    this.commandLogScope = scope;
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
    const clear = (): void => {
      this.commitMessage = '';
      this.amend = false;
    };
    // ブランチ一覧の取り直しは #operate が成功したときだけ行う（確認待ちで止まったら取り直さない）
    await this.#operate(
      (confirmed) => this.#ft.commit(this.#id(), { message, amend }, confirmed),
      () =>
        this.#operate(() => this.#ft.commit(this.#id(), { message, amend }, true), undefined, clear, {
          branches: true,
        }),
      clear,
      { branches: true },
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
    await this.#operate(() => this.#ft.remoteFetch(this.#id(), remote), undefined, undefined, { branches: true });
  }

  async pull(): Promise<void> {
    await this.#operate(() => this.#ft.remotePull(this.#id()), undefined, undefined, { branches: true });
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
      { branches: true },
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
   *
   * 対象のタブは**呼んだ時点の activeId で固定する**。操作中に別のタブへ移られても、
   * 読み込み帯と反映は操作を始めたタブに付く（#reflect）。確認待ちで止まったときは
   * ここで抜けるので、ダイアログを出している間は帯を出さない。
   *
   * @param options.branches 成功したらブランチ一覧も取り直す（コミット・リモート操作）。
   */
  async #operate<T>(
    call: (confirmed?: boolean) => Promise<Result<T>>,
    retry?: () => Promise<void>,
    onSuccess?: () => void,
    options: { readonly branches?: boolean } = {},
  ): Promise<void> {
    const id = this.activeId;
    const body = async (): Promise<void> => {
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
      if (id === null) return;
      await this.#reflect(id, async () => {
        await this.reloadActive();
        if (options.branches === true && this.activeId === id) await this.reloadBranches();
      });
    };
    // タブが無いときは call の中の #id() が投げ、#run がエラー帯に出す
    await this.#run(() => (id === null ? body() : this.#updating(id, body)));
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

  /**
   * 表示を更新する操作を、読み込み帯の「意図」として包む（tabActivity.ts）。
   * 反映の終わりは DOM の更新まで（tick）とする。
   *
   * @param immediate 中身がまだ無いタブなら true（帯を遅延なしで出す）。
   */
  async #updating(id: string, body: () => Promise<void>, immediate = false): Promise<void> {
    this.#tabActivity.begin(id, immediate);
    try {
      await body();
      await tick();
    } finally {
      this.#tabActivity.end(id);
    }
  }

  /**
   * 操作の結果を、操作を始めたタブの表示へ反映する。
   *
   * 終わった時点で別のタブへ移っていたら読み直さず、**そのタブのキャッシュを捨てる**。
   * 残しておくと、戻ったときに操作前の表示が復元され、タブ切替では読み直しも
   * 走らないので古いまま居座る。捨てておけば、戻ったときにキャッシュの無いタブとして
   * main のスナップショットを読み直す（git は走らない）。
   * 反映の途中で移られた場合も同じ（reload* は移られたら書き込まずに抜ける）。
   */
  async #reflect(id: string, reload: () => Promise<void>): Promise<void> {
    if (this.activeId === id) await reload();
    if (this.activeId !== id) this.#cache.delete(id);
  }

  /**
   * 実行中通知が変わったタブについて、状態系の git が走っているかを読み込み帯へ伝える。
   * main が自発的に走らせる git（ウィンドウ復帰時の自動更新）は renderer に意図が無いので、
   * これでしか拾えない。
   */
  #syncGitActivity(sessionId: string): void {
    const running = this.runningCommands.some(
      (c) => c.sessionId === sessionId && !VIEW_ONLY_COMMANDS.has(c.args[0] ?? ''),
    );
    this.#tabActivity.setGit(sessionId, running);
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
