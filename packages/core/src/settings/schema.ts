import {
  boolOr,
  clampFloatOrNull,
  clampInt,
  intOrNull,
  pickFrom,
  record,
  stringArray,
  stringArrayRecord,
  stringOrNull,
} from '@feathertree/base-core';
import { isAbsolute } from 'node:path';

export type ThemeName = 'classic-dark' | 'classic-light' | 'phoenix-dark' | 'phoenix-light';
/**
 * ペイン領域のモード（決定 27 / 31）。
 *
 *  - 'diff'       差分モード。左右 2 分割（作業ツリー / 差分）
 *  - 'stash'      Stash 保存モード。**差分モードと同じ 2 ペイン**で、下端の箱だけが替わる
 *  - 'log'        コミットログモード。上下 2 分割（履歴 / コミット詳細）
 *  - 'stash-list' Stash 解放モード。上下 2 分割（stash 一覧 / stash 詳細）
 *  - 'unity'      Unity Prefab 差分モード（決定 32）。**差分モードと同じ 2 ペインの土台**で、
 *                 右が Unity ペイン（ヒエラルキー / プロパティ表の左右 2 分割）に替わる
 */
export type ViewMode = 'diff' | 'log' | 'stash' | 'stash-list' | 'unity';
/** ウィンドウ復帰時の更新方式（決定14の唯一の自動入口の挙動）。 */
export type RefocusUpdateMode = 'auto' | 'modal' | 'none';

export interface PaneWidths {
  readonly left: number;
  /** @deprecated centerRatio への移行用の種。移行後は更新されない。 */
  readonly center: number;
  /** WorkingTreePane が center+diff の中で占める比率（0..1）。null は「まだ移行していない」。 */
  readonly centerRatio: number | null;
}

export interface AppSettings {
  /** 設定画面で明示指定した git.exe のパス。null なら自動探索。 */
  readonly gitPath: string | null;
  /**
   * SSH 秘密鍵。**リポジトリの絶対パス → 鍵の絶対パス**（決定 13 の追記）。
   *
   * **このアプリが spawn する git にだけ** `GIT_SSH_COMMAND` として渡す。
   * 登録の無いリポジトリには何も注入せず、ユーザー自身の `GIT_SSH_COMMAND` /
   * `core.sshCommand` が効く。鍵の中身もパスフレーズも保持しない（保持するのはパスだけ）。
   *
   * リポジトリごとに持つのは、鍵をホストごとに使い分けるのが普通で、
   * アプリ全体に 1 本だと別ホストの認証を巻き添えにするため。
   */
  readonly sshKeyPaths: Readonly<Record<string, string>>;
  readonly theme: ThemeName;
  /** status の rename 検出を切る。巨大リポで所要時間に効く。 */
  readonly noRenames: boolean;
  readonly diffContextLines: number;
  readonly diffMaxLines: number;
  readonly logPageSize: number;
  /** どのモードを出しているか（決定 27 / 31）。 */
  readonly viewMode: ViewMode;
  /**
   * コミットログモードの下部（コミット詳細）ペインの高さ（px）。残りはコミットリストに割り当てる。
   *
   * 折り畳みの状態を持たないのは、縦帯の折り畳みボタンが**どちらのモードでも
   * ブランチペインを相手にする**ため（決定 27）。畳めるペインは 1 つだけなので、
   * 状態も `branchPaneCollapsed` 1 つで足りる。
   */
  readonly logDetailHeight: number;
  /** コミット詳細ペイン「変更」タブの、左のファイルリストの幅（px）。 */
  readonly commitFileListWidth: number;
  /**
   * Stash 解放モードの下部（stash 詳細）ペインの高さ（px）。
   *
   * `logDetailHeight` と**共有しない**。同じ上下 2 分割の形でも、読むものの量が違う
   * （コミット詳細はメタ情報と本文が主、stash 詳細はファイル一覧と差分が主）ので、
   * 片方で決めた高さがもう片方に伝染すると、モードを行き来するたびに直すことになる。
   */
  readonly stashDetailHeight: number;
  /** stash 詳細ペインの、左のファイルリストの幅（px）。理由は stashDetailHeight と同じ。 */
  readonly stashFileListWidth: number;
  /**
   * Unity ペインの、左の Prefab ヒエラルキーの幅（px）。残りはプロパティ表に割り当てる。
   *
   * 他のファイルリストと共有しない（決定 32）。ヒエラルキーは階層の深さぶん
   * 横に伸びるので、平たいファイル一覧より広く取りたくなる。
   */
  readonly unityHierarchyWidth: number;
  /**
   * リポジトリタブに現在情報（ブランチ名と HEAD の件名）を出すか（決定 24）。
   * 切ると従来どおりリポジトリ名だけになる。
   */
  readonly tabShowCurrentInfo: boolean;
  readonly paneWidths: PaneWidths;
  /** ブランチペインの「ローカル」セクションの高さ（px）。残りは「リモート」に割り当てる。 */
  readonly branchLocalHeight: number;
  /** ブランチペインを左端の細い帯に折り畳んでいるか。 */
  readonly branchPaneCollapsed: boolean;
  /**
   * ブランチペインで展開中のフォルダ。リポジトリの絶対パス → 展開パスの配列。
   * 値は 'local:feature/ui' のように 'local:' / 'remote:' を前置きしたフルパス。
   * 既定は全折りたたみなので、開いている側を保存する。
   */
  readonly branchExpanded: Readonly<Record<string, readonly string[]>>;
  /** 「実行ログ」パネルの高さ（px）。 */
  readonly commandLogHeight: number;
  /** WorkingTreePane の「ステージ済み」セクションの高さ（px）。残りは「変更」に割り当てる。 */
  readonly stagedHeight: number;
  readonly refocusUpdateMode: RefocusUpdateMode;
  /** 最近開いたリポジトリ（新しい順）。 */
  readonly recentRepositories: readonly string[];
  /** 起動時に復元するタブ。 */
  readonly openRepositories: readonly string[];

  /* ---------------------------------------------------------------- 更新通知（決定 29） */

  /** 起動時の自動確認（本体ウィンドウ表示後、24 時間に 1 回）。オフなら手動確認のみ。 */
  readonly checkForUpdates: boolean;
  /** 最後に確認を試みた時刻（epoch ms）。未確認は null。結果に関わらず試みたら保存する。 */
  readonly lastUpdateCheckAt: number | null;
  /** 「この版は通知しない」で選んだバージョン（'x.y.z'）。手動確認では無視する。 */
  readonly dismissedUpdateVersion: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  gitPath: null,
  sshKeyPaths: {},
  theme: 'phoenix-light',
  noRenames: false,
  diffContextLines: 3,
  diffMaxLines: 20000,
  logPageSize: 200,
  viewMode: 'diff',
  logDetailHeight: 260,
  commitFileListWidth: 260,
  stashDetailHeight: 260,
  stashFileListWidth: 260,
  unityHierarchyWidth: 320,
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

const THEMES: readonly ThemeName[] = ['classic-dark', 'classic-light', 'phoenix-dark', 'phoenix-light'];
const REFOCUS_MODES: readonly RefocusUpdateMode[] = ['auto', 'modal', 'none'];
const VIEW_MODES: readonly ViewMode[] = ['diff', 'log', 'stash', 'stash-list', 'unity'];

/** 絶対パスの上限。Windows の MAX_PATH は 260 だが、長パス有効時はもっと長くなりうる。 */
const MAX_PATH_LENGTH = 4096;

/**
 * 「絶対パスか null」を保つ値。
 *
 * 相対パス・bare 名を弾くのは、そのまま spawn の実行ファイルや ssh の引数になるため。
 * Windows の libuv は相対パスを cwd（＝リポジトリルート）から先に探すので、
 * リポジトリ内に置かれた同名の実行ファイルを掴む余地が生まれる
 * （`register.ts` の launchTerminal が同じ理由で isAbsolute を強制している）。
 * 制御文字は、設定ファイルを手で壊したときに引数の途中で切れないよう弾く。
 */
function absolutePathOrNull(value: unknown): string | null {
  const text = stringOrNull(value);
  if (text === null || text.length > MAX_PATH_LENGTH || !isAbsolute(text)) return null;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return text;
}

/**
 * 鍵を覚えておくリポジトリの上限。branchExpanded と同じく、
 * 際限なく増える辞書なので頭打ちにする。
 */
const MAX_SSH_KEY_ENTRIES = 100;

/**
 * 「絶対パス → 絶対パス」の辞書（リポジトリ → SSH 鍵）。
 * キーも値も絶対パスでなければその 1 件を捨てる（理由は absolutePathOrNull と同じ）。
 */
function absolutePathRecord(value: unknown, keyLimit: number): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  let kept = 0;
  for (const [key, raw] of Object.entries(record(value))) {
    if (kept >= keyLimit) break;
    if (absolutePathOrNull(key) === null) continue;
    const path = absolutePathOrNull(raw);
    if (path === null) continue;
    out[key] = path;
    kept += 1;
  }
  return out;
}

/**
 * 設定ファイルは人間が手で編集しうるし、古いバージョンの残骸も入る。
 * 未知・不正な値は既定値で埋めて必ず有効な設定を返す（起動を止めない）。
 */
export function normalizeSettings(raw: unknown): AppSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SETTINGS;
  const o = record(raw);

  return {
    /*
     * gitPath は stringOrNull のまま（絶対パスを強制しない）。
     * 既に相対パスを書いている利用者の設定を、更新しただけで黙って null（自動探索）へ
     * 落とさないため。新しく保存される値は service.settingsUpdate 側で絶対パスを要求する。
     */
    gitPath: stringOrNull(o['gitPath']),
    sshKeyPaths: absolutePathRecord(o['sshKeyPaths'], MAX_SSH_KEY_ENTRIES),
    theme: pickFrom(o['theme'], THEMES, DEFAULT_SETTINGS.theme),
    noRenames: boolOr(o['noRenames'], DEFAULT_SETTINGS.noRenames),
    diffContextLines: clampInt(o['diffContextLines'], 0, 20, DEFAULT_SETTINGS.diffContextLines),
    diffMaxLines: clampInt(o['diffMaxLines'], 100, 200000, DEFAULT_SETTINGS.diffMaxLines),
    logPageSize: clampInt(o['logPageSize'], 20, 2000, DEFAULT_SETTINGS.logPageSize),
    viewMode: pickFrom(o['viewMode'], VIEW_MODES, DEFAULT_SETTINGS.viewMode),
    logDetailHeight: clampInt(o['logDetailHeight'], 120, 2000, DEFAULT_SETTINGS.logDetailHeight),
    commitFileListWidth: clampInt(
      o['commitFileListWidth'],
      120,
      1200,
      DEFAULT_SETTINGS.commitFileListWidth,
    ),
    stashDetailHeight: clampInt(o['stashDetailHeight'], 120, 2000, DEFAULT_SETTINGS.stashDetailHeight),
    stashFileListWidth: clampInt(o['stashFileListWidth'], 120, 1200, DEFAULT_SETTINGS.stashFileListWidth),
    unityHierarchyWidth: clampInt(
      o['unityHierarchyWidth'],
      160,
      1200,
      DEFAULT_SETTINGS.unityHierarchyWidth,
    ),
    tabShowCurrentInfo: boolOr(o['tabShowCurrentInfo'], DEFAULT_SETTINGS.tabShowCurrentInfo),
    paneWidths: {
      left: clampInt(record(o['paneWidths'])['left'], 120, 1200, DEFAULT_SETTINGS.paneWidths.left),
      center: clampInt(record(o['paneWidths'])['center'], 200, 2000, DEFAULT_SETTINGS.paneWidths.center),
      centerRatio: clampFloatOrNull(record(o['paneWidths'])['centerRatio'], 0.1, 0.9),
    },
    branchLocalHeight: clampInt(o['branchLocalHeight'], 80, 4000, DEFAULT_SETTINGS.branchLocalHeight),
    branchPaneCollapsed: boolOr(o['branchPaneCollapsed'], DEFAULT_SETTINGS.branchPaneCollapsed),
    branchExpanded: stringArrayRecord(o['branchExpanded'], 30, 2000),
    commandLogHeight: clampInt(o['commandLogHeight'], 120, 800, DEFAULT_SETTINGS.commandLogHeight),
    stagedHeight: clampInt(o['stagedHeight'], 80, 4000, DEFAULT_SETTINGS.stagedHeight),
    refocusUpdateMode: pickFrom(o['refocusUpdateMode'], REFOCUS_MODES, DEFAULT_SETTINGS.refocusUpdateMode),
    recentRepositories: stringArray(o['recentRepositories'], 30),
    openRepositories: stringArray(o['openRepositories'], 20),
    checkForUpdates: boolOr(o['checkForUpdates'], DEFAULT_SETTINGS.checkForUpdates),
    lastUpdateCheckAt: intOrNull(o['lastUpdateCheckAt'], 0),
    dismissedUpdateVersion: stringOrNull(o['dismissedUpdateVersion']),
  };
}
