import {
  boolOr,
  clampFloatOrNull,
  clampInt,
  pickFrom,
  record,
  stringArray,
  stringArrayRecord,
  stringOrNull,
} from '@feathertree/base-core';

export type ThemeName = 'classic-dark' | 'classic-light' | 'phoenix-dark' | 'phoenix-light';
export type UntrackedMode = 'normal' | 'all';
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
  readonly theme: ThemeName;
  /** status の rename 検出を切る。巨大リポで所要時間に効く。 */
  readonly noRenames: boolean;
  readonly untrackedFiles: UntrackedMode;
  readonly diffContextLines: number;
  readonly diffMaxLines: number;
  readonly logPageSize: number;
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
  /** 実行ログパネルの高さ（px）。 */
  readonly commandLogHeight: number;
  /** WorkingTreePane の「ステージ済み」セクションの高さ（px）。残りは「変更」に割り当てる。 */
  readonly stagedHeight: number;
  readonly refocusUpdateMode: RefocusUpdateMode;
  /** 最近開いたリポジトリ（新しい順）。 */
  readonly recentRepositories: readonly string[];
  /** 起動時に復元するタブ。 */
  readonly openRepositories: readonly string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  gitPath: null,
  theme: 'phoenix-light',
  noRenames: false,
  untrackedFiles: 'normal',
  diffContextLines: 3,
  diffMaxLines: 20000,
  logPageSize: 200,
  paneWidths: { left: 260, center: 420, centerRatio: null },
  branchLocalHeight: 180,
  branchPaneCollapsed: false,
  branchExpanded: {},
  commandLogHeight: 220,
  stagedHeight: 180,
  refocusUpdateMode: 'auto',
  recentRepositories: [],
  openRepositories: [],
};

const THEMES: readonly ThemeName[] = ['classic-dark', 'classic-light', 'phoenix-dark', 'phoenix-light'];
const UNTRACKED: readonly UntrackedMode[] = ['normal', 'all'];
const REFOCUS_MODES: readonly RefocusUpdateMode[] = ['auto', 'modal', 'none'];

/**
 * 設定ファイルは人間が手で編集しうるし、古いバージョンの残骸も入る。
 * 未知・不正な値は既定値で埋めて必ず有効な設定を返す（起動を止めない）。
 */
export function normalizeSettings(raw: unknown): AppSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SETTINGS;
  const o = record(raw);

  return {
    gitPath: stringOrNull(o['gitPath']),
    theme: pickFrom(o['theme'], THEMES, DEFAULT_SETTINGS.theme),
    noRenames: boolOr(o['noRenames'], DEFAULT_SETTINGS.noRenames),
    untrackedFiles: pickFrom(o['untrackedFiles'], UNTRACKED, DEFAULT_SETTINGS.untrackedFiles),
    diffContextLines: clampInt(o['diffContextLines'], 0, 20, DEFAULT_SETTINGS.diffContextLines),
    diffMaxLines: clampInt(o['diffMaxLines'], 100, 200000, DEFAULT_SETTINGS.diffMaxLines),
    logPageSize: clampInt(o['logPageSize'], 20, 2000, DEFAULT_SETTINGS.logPageSize),
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
  };
}
