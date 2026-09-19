import type { FeatherTreeBridge } from '@feathertree/ipc';
import type {
  AppInfoDto,
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
  GitIdentityDto,
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
  UpdateStateDto,
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
 * 失敗の履歴を持つ件数（docs/01-architecture.md 5 章「操作の失敗も同じパネルに集める」）。
 * 実行ログと違い main 側に正本が無く、遡って読みたいのは直近だけなので短くてよい。
 */
const ERROR_LOG_LIMIT = 50;

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

/**
 * 失敗の履歴 1 件（docs/01-architecture.md 5 章）。
 *
 * エラー帯（`error`）は 1 件しか持てず、手で閉じるまで消えないので
 * 「原因が解消した後も今も壊れているように見える」。履歴なら後から追える。
 */
export interface ErrorLogEntry {
  /** 単調増加。リストの key に使う（同じミリ秒に 2 件出ても衝突しない）。 */
  readonly id: number;
  readonly at: number;
  /** どのタブの失敗か。タブの外（クローン・設定）なら null。 */
  readonly sessionId: string | null;
  readonly message: string;
  /** git の原文（あれば）。 */
  readonly detail?: string;
}

/**
 * `$state` のプロキシを剥がし、structured clone（contextBridge）を通る素の辞書に組み直す。
 *
 * `branchExpanded` の値（配列）はリポジトリごとに `$state` の中で育つので、
 * `{ ...settings.branchExpanded }` の浅いコピーではプロキシ配列がそのまま残る。
 * リポジトリを 2 つ以上開いて両方に展開状態があると、送るたびに他リポジトリの
 * プロキシ配列が IPC 境界へ出ていき「An object could not be cloned.」で落ちる。
 */
function plainExpanded(source: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  const plain: Record<string, string[]> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value !== undefined) plain[key] = Array.from(value);
  }
  return plain;
}

export interface PendingConfirmation {
  readonly confirmation: ConfirmationDto;
  /** 承認されたら再実行する処理。 */
  readonly retry: () => Promise<void>;
  /**
   * 承認以外の代替行動（例: 実行されうるファイルを開く確認での「フォルダで表示」）。
   * 無ければ ConfirmDialog はキャンセル／承認の 2 択のまま出す。
   */
  readonly secondary?: { readonly label: string; readonly onClick: () => void };
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
  /** 設定ダイアログの「更新」節で現在のバージョンを出すためだけに持つ。 */
  appInfo = $state<AppInfoDto | null>(null);

  /**
   * 設定ダイアログの Git タブが出すコミット情報（対応表 #42〜#44）。
   * null は「まだ読んでいない」か「対象のタブが無い」。
   */
  gitIdentity = $state<GitIdentityDto | null>(null);
  gitIdentityLoading = $state(false);

  /**
   * 更新通知（決定 29）。既定は 'unknown'（まだ 1 度も確認結果を受け取っていない）。
   * 起動時の自動確認は main 側で本体表示から数秒後に走るので、initialize() で
   * updateGetState を呼んで取りこぼしに備え、以後は onUpdateAvailable の通知で更新する。
   */
  updateState = $state<UpdateStateDto>({ outcome: 'unknown', version: null });
  /** 「今すぐ確認」ボタンの実行中表示。 */
  checkingUpdate = $state(false);

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
  /**
   * diff の取得に失敗したときの理由。成功なら null。
   *
   * 失敗で `diff` を null に戻すだけだと、画面には「差分はありません。」と出てしまい
   * **取れなかったことと差分がゼロであることが区別できない**。描画の出し分けは View 層が持つ。
   */
  diffError = $state<FtErrorDto | null>(null);

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

  /**
   * 実行中の `#run` の本数。
   *
   * boolean で持つと、**並行する `#run` 同士が互いの busy を上書きする**
   * （先に終わったほうが、まだ走っている操作の busy を解除してしまう）。
   * 読む側（ボタンの disabled 等）の意味は boolean のままにするので、露出は `busy` の getter。
   */
  #busyCount = $state(0);

  /** 何かしらの操作が実行中か。 */
  get busy(): boolean {
    return this.#busyCount > 0;
  }

  /**
   * 直近の失敗（エラー帯）。**自動では消さない**——同期的に読む呼び出し元が多いため。
   * 消える口は次の操作の開始（`#run` の冒頭）と `dismissError()`。履歴は `errorLog`。
   */
  error = $state<FtErrorDto | null>(null);

  /** 失敗の履歴（新しい順）。上限 ERROR_LOG_LIMIT 件。 */
  #errorLog = $state<ErrorLogEntry[]>([]);
  #errorSeq = 0;

  get errorLog(): readonly ErrorLogEntry[] {
    return this.#errorLog;
  }

  /**
   * パネルに出す失敗。**実行ログと同じ表示範囲の規則に従う**（visibleCommandLog と対称）。
   *
   * 「開いているすべてのリポジトリ」を選んだときだけ、**タブに属さない失敗**（クローンは
   * セッションが立つ前に走るので sessionId が null）と**閉じたタブの失敗**が出る。
   * 既定（アクティブなタブの分だけ）では辿り着けないので、
   * パネルは空のときの文言でチェックを入れるよう案内する。
   */
  get visibleErrorLog(): readonly ErrorLogEntry[] {
    if (this.commandLogScope === 'all') return this.#errorLog;
    const id = this.activeId;
    if (id === null) return [];
    return this.#errorLog.filter((e) => e.sessionId === id);
  }

  clearErrorLog(): void {
    this.#errorLog = [];
  }

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

  /** 縦帯下端の設定ボタンにバッジを出すか（決定 29）。 */
  get hasUpdateAvailable(): boolean {
    return this.updateState.outcome === 'new-version';
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
    const [info, env, settings, list, updateState] = await Promise.all([
      this.#ft.appGetInfo(),
      this.#ft.appGetEnvironment(),
      this.#ft.settingsGet(),
      this.#ft.sessionList(),
      this.#ft.updateGetState(),
    ]);

    if (info.ok) this.appInfo = info.value;
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
    /*
     * 起動時の自動確認（決定 29）は main 側で本体表示から数秒後に走る。
     * ここで取っておくのは、それが renderer の初期化より先に終わっていた場合の取りこぼし対策。
     * 後から届く分は onUpdateAvailable が更新する。
     */
    if (updateState.ok) this.updateState = updateState.value;
    this.#ft.onUpdateAvailable((event) => {
      this.updateState = { outcome: 'new-version', version: event.version };
    });

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
  /*
   * `#run` で包むのは 1 段目（フォルダ選択と #1）のため。ここが返らないと——切断された UNC や
   * オフラインの OneDrive を選ぶと #1 はタイムアウトまで返らない——タブもまだ無く、
   * コマンドバーにも映らない（#1 は track() を通らない）ので、**手がかりがひとつも無い**。
   * busy が立てば少なくとも操作中だと分かる。2 段目の読み込み帯は `#addOpenedTab` が出す。
   */
  async openRepository(): Promise<void> {
    await this.#run(async () => {
      const picked = await this.#ft.sessionPickAndCreate();
      if (!this.#check(picked) || picked.value === null) return;
      await this.#addOpenedTab(picked.value);
    });
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
      // クローンはまだタブに属さないので sessionId は null
      this.#setError({ kind: 'internal', message: err instanceof Error ? err.message : '不明なエラー' }, null);
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
      if (result.ok) {
        this.diff = result.value;
        this.diffError = null;
        return;
      }
      /*
       * 失敗を diff = null に畳むと「差分はありません。」と同じ見え方になる。
       * エラー帯（error）には出さない——選択に伴う読み取りなので、操作を始めた覚えが
       * 無いところで帯が出る。履歴と diffError に残して、描画側が出し分ける。
       */
      this.diff = null;
      this.diffError = result.error;
      this.#logError(result.error, id);
    } finally {
      // 新しい要求が走っているなら、その読み込み表示を消さない
      if (seq === this.#diffSeq) this.diffLoading = false;
    }
  }

  /** 飛んでいる diff 要求を無効にしてから差分を消す。 */
  #invalidateDiff(): void {
    this.#diffSeq += 1;
    this.diff = null;
    this.diffError = null;
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
    await this.#writeSettings({ viewMode: mode });
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
        this.#setError(result.error, id);
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
      if (!result.ok) this.#setError(result.error, id);
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
      if (!result.ok) this.#setError(result.error, id);
    } finally {
      if (seq === this.#commitDiffSeq) this.commitDiffLoading = false;
    }
  }

  /** コミット詳細ペインの高さの永続化。 */
  async setLogDetailHeight(px: number): Promise<void> {
    const clamped = Math.min(2000, Math.max(120, Math.round(px)));
    await this.#writeSettings({ logDetailHeight: clamped });
  }

  /** 「変更」タブの左ファイルリスト幅の永続化。 */
  async setCommitFileListWidth(px: number): Promise<void> {
    const clamped = Math.min(1200, Math.max(120, Math.round(px)));
    await this.#writeSettings({ commitFileListWidth: clamped });
  }

  async setTheme(theme: SettingsDto['theme']): Promise<void> {
    const applied = await this.#writeSettings({ theme });
    if (applied !== null) applyTheme(applied.theme);
  }

  /**
   * ファイル一覧(center)と差分(diff)の比率の永続化。
   * SettingsStore.update() は浅いマージなので、paneWidths は他フィールドも含めて送る
   * （centerRatio だけ送ると left/center が既定値に戻ってしまう）。
   */
  async setCenterRatio(ratio: number): Promise<void> {
    if (this.settings === null) return;
    const clamped = Math.min(0.9, Math.max(0.1, ratio));
    await this.#writeSettings({
      paneWidths: { ...this.settings.paneWidths, centerRatio: clamped },
    });
  }

  /**
   * ブランチペイン幅の永続化。
   * SettingsStore.update() は浅いマージなので、paneWidths は他フィールドも含めて送る
   * （left だけ送ると center/centerRatio が既定値に戻ってしまう）。
   */
  async setLeftWidth(px: number): Promise<void> {
    if (this.settings === null) return;
    const clamped = Math.min(1200, Math.max(120, Math.round(px)));
    await this.#writeSettings({
      paneWidths: { ...this.settings.paneWidths, left: clamped },
    });
  }

  /** ブランチペインの ローカル/リモート 分割高さの永続化。 */
  async setBranchLocalHeight(px: number): Promise<void> {
    if (this.settings === null) return;
    const clamped = Math.min(4000, Math.max(80, Math.round(px)));
    await this.#writeSettings({ branchLocalHeight: clamped });
  }

  /** ブランチペインの折り畳み状態の永続化。 */
  async setBranchPaneCollapsed(collapsed: boolean): Promise<void> {
    await this.#writeSettings({ branchPaneCollapsed: collapsed });
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
    const settings = this.settings;
    if (root === null || settings === null) {
      /*
       * 黙って抜けると「押しても三角が動かない」だけが残り、何も手がかりが無い。
       * 起きるのは設定の読み込み前かタブが無いときだけなので、帯には出さず履歴に残す。
       */
      this.#logError({
        kind: 'internal',
        message: 'ブランチの展開状態を保存できませんでした（リポジトリまたは設定が未読込）。',
      });
      return;
    }

    /*
     * 辞書は全体を送る（SettingsStore.update() は浅いマージ）。
     * 使用中のリポジトリのキーを先頭に置き、上限（30 件）を超えたときに
     * 今開いているリポジトリの状態が切り捨てられないようにする。
     * plainExpanded / Array.from で $state のプロキシを剥がしてから組み立てる。
     */
    const rest = plainExpanded(settings.branchExpanded);
    delete rest[root];
    const next: Record<string, string[]> = paths.length === 0 ? rest : { [root]: Array.from(paths), ...rest };

    // 先に画面へ反映する。IPC の往復を待つと、main が重い git を抱えている間
    // クリックしても三角マークすら変わらず「無反応」に見える。
    const previous = settings.branchExpanded;
    this.settings = { ...settings, branchExpanded: next };

    /*
     * settingsUpdate が **reject** するとここから先に到達せず、下のロールバックが走らない。
     * 呼び出し元（BranchPane）は void 呼び出しなので unhandled rejection として黙殺され、
     * 画面だけが「展開されたまま」になって設定には何も保存されない
     * （実機の settings.json で branchExpanded だけが {} のまま残っていた原因）。
     */
    try {
      const result = await this.#ft.settingsUpdate({ branchExpanded: next });
      if (result.ok) {
        this.#mergeSettings({ branchExpanded: next }, result.value);
        return;
      }
      this.#restoreBranchExpanded(previous);
      this.#setError(result.error);
    } catch (err) {
      this.#restoreBranchExpanded(previous);
      this.#setError({ kind: 'internal', message: err instanceof Error ? err.message : '不明なエラー' });
    }
  }

  /** 保存できなかったときに、楽観更新した展開状態だけを元へ戻す。 */
  #restoreBranchExpanded(previous: Readonly<Record<string, readonly string[]>>): void {
    if (this.settings === null) return;
    this.settings = { ...this.settings, branchExpanded: previous };
  }

  /** 実行ログパネルの高さの永続化。 */
  async setCommandLogHeight(px: number): Promise<void> {
    if (this.settings === null) return;
    const clamped = Math.min(800, Math.max(120, Math.round(px)));
    await this.#writeSettings({ commandLogHeight: clamped });
  }

  /** WorkingTreePane の ステージ済み/変更 分割高さの永続化。 */
  async setStagedHeight(px: number): Promise<void> {
    if (this.settings === null) return;
    const clamped = Math.min(4000, Math.max(80, Math.round(px)));
    await this.#writeSettings({ stagedHeight: clamped });
  }

  /** リポジトリタブに現在情報を出すかの永続化（決定 24）。 */
  async setTabShowCurrentInfo(show: boolean): Promise<void> {
    await this.#writeSettings({ tabShowCurrentInfo: show });
  }

  async setRefocusUpdateMode(mode: SettingsDto['refocusUpdateMode']): Promise<void> {
    await this.#writeSettings({ refocusUpdateMode: mode });
  }

  /* ---------------------------------------------------------------- Git / ssh 通信の設定 */

  /**
   * git.exe のパスの永続化（決定 7）。null で自動探索に戻す。
   *
   * main は gitPath が変わると git を解決し直すので、**検出結果（environment）も取り直す**。
   * 取り直さないと「どの git を使っているか」の表示が古いまま残り、
   * 指定したのに効いていないように見える。
   * 失敗（絶対パスでない等）はエラー帯に出す——黙って捨てない。
   */
  async setGitPath(path: string | null): Promise<void> {
    const result = await this.#ft.settingsUpdate({ gitPath: path });
    if (!this.#check(result)) return;
    this.settings = result.value;
    await this.refreshEnvironment();
  }

  /** SSH 秘密鍵のパスの永続化（決定 13 の追記）。null で「使わない」。git は動かない。 */
  async setSshKeyPath(path: string | null): Promise<void> {
    const result = await this.#ft.settingsUpdate({ sshKeyPath: path });
    if (this.#check(result)) this.settings = result.value;
  }

  /** git の検出結果を取り直す。git は動かない（main が持っている解決済みの情報を読むだけ）。 */
  async refreshEnvironment(): Promise<void> {
    const result = await this.#ft.appGetEnvironment();
    if (result.ok) this.environment = result.value;
  }

  /** git.exe を選んで保存する。キャンセルなら何もしない。 */
  async pickGitExecutable(): Promise<void> {
    const picked = await this.#ft.dialogPickFile('git-executable');
    if (!this.#check(picked) || picked.value === null) return;
    await this.setGitPath(picked.value);
  }

  /** SSH 秘密鍵を選んで保存する。キャンセルなら何もしない。 */
  async pickSshKey(): Promise<void> {
    const picked = await this.#ft.dialogPickFile('ssh-private-key');
    if (!this.#check(picked) || picked.value === null) return;
    await this.setSshKeyPath(picked.value);
  }

  /**
   * 対応表 #42（→ 必要なら #43）: アクティブなタブのコミット情報を読む。
   *
   * 設定ダイアログの Git タブを開いたとき・対象のタブが変わったときだけ呼ぶ。
   * タブが無ければ git を動かさずに状態を空にする。
   */
  async loadGitIdentity(): Promise<void> {
    const id = this.activeId;
    if (id === null) {
      this.gitIdentity = null;
      return;
    }
    this.gitIdentityLoading = true;
    try {
      const result = await this.#ft.gitConfigGetIdentity(id);
      // 読んでいる間にタブが変わったら、古い応答は捨てる
      if (this.activeId !== id) return;
      this.gitIdentity = this.#check(result) ? result.value : null;
    } finally {
      this.gitIdentityLoading = false;
    }
  }

  /**
   * 対応表 #44: コミット情報をこのリポジトリの .git/config に保存する。
   *
   * **変えたキーだけ**を送る（両方同じなら git を 1 本も動かさない）。
   * main は保存後に読み直さないので、手元の状態をローカル値として進める
   * （書いたキーがローカル値になるのは確実）。
   */
  async saveGitIdentity(name: string, email: string): Promise<boolean> {
    const id = this.activeId;
    if (id === null) return false;

    const current = this.gitIdentity;
    const changed = (key: 'name' | 'email', value: string): string | null => {
      const field = current?.[key];
      // 継承値と同じ文字でも、ローカルに固定する意味があるので「変更」と見なす
      return field?.scope === 'local' && field.value === value ? null : value;
    };
    const req = { name: changed('name', name), email: changed('email', email) };
    if (req.name === null && req.email === null) return true;

    const result = await this.#ft.gitConfigSetIdentity(id, req);
    if (!this.#check(result)) return false;

    this.gitIdentity = {
      name: req.name === null ? (current?.name ?? { value: null, scope: 'unset' }) : { value: req.name, scope: 'local' },
      email: req.email === null ? (current?.email ?? { value: null, scope: 'unset' }) : { value: req.email, scope: 'local' },
    };
    return true;
  }

  /* ---------------------------------------------------------------- 更新通知（決定 29） */

  /** 起動時の自動確認オンオフの永続化。 */
  async setCheckForUpdates(enabled: boolean): Promise<void> {
    await this.#writeSettings({ checkForUpdates: enabled });
  }

  /* ---------------------------------------------------------------- 設定の書き込み（共通） */

  /**
   * 設定を 1 件書いて、**送った patch のキーだけ**を自分の `settings` へ重ねる。
   *
   * `result.value` は main がその patch を適用した時点のスナップショットなので、
   * 丸ごと代入すると **それ以降に renderer 側で積んだローカルな変更が無条件に消える**。
   * 実際の症状は「ペイン幅をドラッグするたびにブランチペインのフォルダが畳まれる」——
   * `setLeftWidth` の応答が遅れている間に入れた `setBranchExpanded` の楽観更新を、
   * 後から届いた応答が巻き戻していた。
   *
   * 値は patch ではなく応答から取る（main がクランプ・正規化した結果を正とするため）。
   *
   * @returns 成功したら重ねた後の設定、失敗したら null。
   */
  async #writeSettings(patch: Partial<SettingsDto>): Promise<SettingsDto | null> {
    const result = await this.#ft.settingsUpdate(patch);
    if (!result.ok) {
      this.#setError(result.error);
      return null;
    }
    return this.#mergeSettings(patch, result.value);
  }

  /** 応答のうち patch に含まれるキーだけを現在の settings に重ねる。 */
  #mergeSettings(patch: Partial<SettingsDto>, applied: SettingsDto): SettingsDto {
    const merged: Record<string, unknown> = { ...(this.settings ?? applied) };
    for (const key of Object.keys(patch)) {
      merged[key] = (applied as unknown as Record<string, unknown>)[key];
    }
    const next = merged as unknown as SettingsDto;
    this.settings = next;
    return next;
  }

  /**
   * 「今すぐ確認」。24 時間の間引きも dismissed も無視して確認する（main 側の仕様）。
   * 結果は updateState に反映し、設定ダイアログの「更新」節が読む。
   */
  async checkForUpdatesNow(): Promise<void> {
    if (this.checkingUpdate) return;
    this.checkingUpdate = true;
    try {
      const result = await this.#ft.updateCheckNow();
      if (this.#check(result)) this.updateState = result.value;
    } finally {
      this.checkingUpdate = false;
    }
  }

  /** ダウンロードページを既定のブラウザで開く。URL は main が持つ検証済み tag から組み立てる。 */
  async openUpdateReleasePage(): Promise<void> {
    this.#check(await this.#ft.updateOpenReleasePage());
  }

  /** 「この版は通知しない」。通知中の版が消え、バッジも下がる。 */
  async dismissUpdate(): Promise<void> {
    if (!this.#check(await this.#ft.updateDismiss())) return;
    this.updateState = { outcome: 'up-to-date', version: null };
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
          log: true,
        }),
      clear,
      { branches: true, log: true },
    );
  }

  /** ブランチのダブルクリックによる切替。確認不要（決定: ブランチ移動は無確認）。 */
  switchBranch(branchName: string): Promise<void> {
    // HEAD が動くので履歴も古くなる（対応表 #12）
    return this.#operate(() => this.#ft.branchSwitch(this.#id(), branchName), undefined, undefined, {
      log: true,
    });
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
   *
   * ブランチ一覧も取り直す（対応表の例外「ブランチ作成後の反映: #14 → #2 → #3」）。
   * **作ったブランチは #3 の結果にしか現れない**ので、取り直さないとブランチペインに出ないまま
   * 現在ブランチの印だけが消える。読むのは main のスナップショットなので git は増えない。
   */
  createBranch(name: string, startPoint: string, onSuccess?: () => void): Promise<void> {
    return this.#operate(
      () => this.#ft.branchCreate(this.#id(), { name, startPoint }),
      undefined,
      onSuccess,
      { branches: true, log: true },
    );
  }

  /**
   * 現在のブランチへ branchName を取り込む。確認が必要（決定 16）。
   * 確認の判定は main が行うので、ここは needs-confirmation を受けて再送するだけ。
   *
   * 成功したときだけブランチ一覧も取り直す（例外「マージ後の反映: #35 → #2 → #3」）。
   * HEAD が進み ahead/behind も変わるので、取り直さないとブランチペインが古いまま残る。
   */
  mergeBranch(branchName: string): Promise<void> {
    return this.#operate(
      (confirmed) => this.#ft.branchMerge(this.#id(), branchName, confirmed),
      () =>
        this.#operate(() => this.#ft.branchMerge(this.#id(), branchName, true), undefined, undefined, {
          branches: true,
          log: true,
        }),
      undefined,
      { branches: true, log: true },
    );
  }

  /**
   * OS 既定のアプリでファイルを開く。どのアプリで開くかは Windows の関連付けに任せる。
   *
   * リポジトリの状態は変わらないので、#operate ではなく軽い経路を使う
   * （成功のたびに一覧と差分を取り直すのは無駄。決定: アイドル時に git を起動しない）。
   *
   * 実行されうる拡張子（脆弱性診断 §5）は main が 'needs-confirmation' で拒否してくる
   * ので、#operate の破壊的操作と同じ形で受けて確認ダイアログを出す。判定自体は
   * ここでは行わない（決定 16 の例外も main 側で強制する）。
   */
  openFile(path: string): Promise<void> {
    return this.#run(async () => {
      const result = await this.#ft.shellOpenPath(this.#id(), path);
      if (result.ok) return;
      const confirmation = result.error.confirmation;
      if (result.error.kind === 'needs-confirmation' && confirmation !== undefined) {
        this.pendingConfirmation = {
          confirmation,
          retry: () =>
            this.#run(async () => {
              this.#check(await this.#ft.shellOpenPath(this.#id(), path, true));
            }),
          // キャンセルする代わりに、実行せずエクスプローラで確認したい利用者のための代替行動
          secondary: { label: 'フォルダで表示', onClick: () => void this.showInFolder(path) },
        };
        return;
      }
      this.error = result.error;
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
    await this.#operate(() => this.#ft.remoteFetch(this.#id(), remote), undefined, undefined, {
      branches: true,
      log: true,
    });
  }

  async pull(): Promise<void> {
    await this.#operate(() => this.#ft.remotePull(this.#id()), undefined, undefined, {
      branches: true,
      log: true,
    });
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
      { branches: true, log: true },
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
   * @param options.branches 成功したらブランチ一覧も取り直す（コミット・ブランチ・リモート操作）。
   * @param options.log HEAD や ahead/behind が動く操作。保持している履歴が古くなる。
   */
  async #operate<T>(
    call: (confirmed?: boolean) => Promise<Result<T>>,
    retry?: () => Promise<void>,
    onSuccess?: () => void,
    options: { readonly branches?: boolean; readonly log?: boolean } = {},
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
        this.#setError(result.error, id);
        return;
      }
      onSuccess?.();
      if (id === null) return;
      await this.#reflect(id, async () => {
        await this.reloadActive();
        if (options.branches === true && this.activeId === id) await this.reloadBranches();
        if (options.log === true && this.activeId === id) await this.#invalidateLog();
      });
    };
    // タブが無いときは call の中の #id() が投げ、#run がエラー帯に出す
    await this.#run(() => (id === null ? body() : this.#updating(id, body)));
  }

  /**
   * 書き込み操作で古くなった履歴を始末する
   * （対応表の例外「書き込み操作後の履歴（コミットログモードのときだけ）」）。
   *
   * - コミットログモード: その場で取り直す（#20 を 1 回）
   * - 差分モード: **保持分を捨てるだけで git は 0 回。** 見えていないもののために git を起動しない
   *   （決定「やらないこと」）。モードに入った瞬間の ensureLog() が取り直す
   */
  async #invalidateLog(): Promise<void> {
    if (this.viewMode === 'log') await this.loadLog();
    else this.#clearLog();
  }

  async #run(body: () => Promise<void>): Promise<void> {
    /*
     * 次の操作を始めた時点で前の失敗の帯を消す。履歴（errorLog）には残るので情報は失わない。
     * **タイマーで自動消去にはしない**——error を同期的に読む呼び出し元が多く、
     * 「いつの間にか消えている」ほうが扱いにくい。
     */
    this.error = null;
    /*
     * カウンタで数える。boolean だと並行する #run 同士が互いの busy を上書きし、
     * 先に終わったほうがまだ走っている操作の busy を解除してしまう。
     */
    this.#busyCount += 1;
    try {
      await body();
    } catch (err) {
      this.#setError({ kind: 'internal', message: err instanceof Error ? err.message : '不明なエラー' });
    } finally {
      this.#busyCount -= 1;
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

  /**
   * 失敗を履歴へ積む。**エラー帯（error）には出さない。**
   *
   * 利用者が操作を始めた覚えの無い失敗（選択に伴う diff の読み取り、設定の保存）は
   * これを使う。帯を出すと「何もしていないのに壊れた」と読まれるため。
   * 履歴は実行ログパネルのエラータブから追える（docs/01-architecture.md 5 章）。
   *
   * @param sessionId 省略時はアクティブなタブ。タブの外の失敗なら null を明示する。
   */
  #logError(error: FtErrorDto, sessionId: string | null = this.activeId): void {
    this.#errorSeq += 1;
    const entry: ErrorLogEntry =
      error.detail === undefined
        ? { id: this.#errorSeq, at: Date.now(), sessionId, message: error.message }
        : { id: this.#errorSeq, at: Date.now(), sessionId, message: error.message, detail: error.detail };
    // 新しい順。上限を超えた分は古いほうから落とす（リングバッファと同じ考え）
    this.#errorLog = [entry, ...this.#errorLog].slice(0, ERROR_LOG_LIMIT);
  }

  /**
   * 失敗を履歴へ積み、**エラー帯にも出す**。
   *
   * 利用者が始めた操作が失敗したときはこちら。帯は次の操作の開始（#run の冒頭）で消えるが、
   * 履歴には残るので情報は失わない。
   */
  #setError(error: FtErrorDto, sessionId: string | null = this.activeId): void {
    this.#logError(error, sessionId);
    this.error = error;
  }
  #check<T>(result: Result<T>): result is { ok: true; value: T } {
    if (result.ok) return true;
    // 帯だけに出して履歴に残さないと、帯が消えた後に何が起きたか追えなくなる
    this.#setError(result.error);
    return false;
  }

  /**
   * 選択中のファイルが、まだ一覧にあるか。
   *
   * **手元にあるのは読み込み済みのページだけ**（既定 200 件、スクロールで追加読み込み）なので、
   * 「見つからない = 消えた」と断定してよいのは全件が手元にあるときだけ。
   * 断定を急ぐと、201 件目以降を選んでいる利用者は更新のたびに選択が外れ、
   * 差分ペインが「差分はありません。」に戻ってしまう。
   *
   * 迷ったら**選択を保つ**側に倒す。誤って選択を消すより、一瞬古い差分を見せるほうが害が小さい
   * （どのみち直後の loadDiff で取り直す）。
   */
  #stillPresent(file: SelectedFile): boolean {
    const section = file.staged ? this.staged : this.changes;
    if (section.entries.some((e) => e?.path === file.path)) return true;
    // 追加読み込み（loadMore）は疎な配列を作るので、length ではなく実体の数を数える
    const loaded = section.entries.reduce<number>((n, e) => (e === undefined ? n : n + 1), 0);
    return loaded < section.total;
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
