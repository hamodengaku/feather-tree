import { boolOr, clampInt, pickFrom, record, stringArray, stringOrNull } from '@feathertree/base-core';

export type ThemeName = 'classic-dark' | 'classic-light' | 'phoenix-dark' | 'phoenix-light';
export type UntrackedMode = 'normal' | 'all';

export interface PaneWidths {
  readonly left: number;
  readonly center: number;
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
  paneWidths: { left: 260, center: 420 },
  recentRepositories: [],
  openRepositories: [],
};

const THEMES: readonly ThemeName[] = ['classic-dark', 'classic-light', 'phoenix-dark', 'phoenix-light'];
const UNTRACKED: readonly UntrackedMode[] = ['normal', 'all'];

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
    },
    recentRepositories: stringArray(o['recentRepositories'], 30),
    openRepositories: stringArray(o['openRepositories'], 20),
  };
}
