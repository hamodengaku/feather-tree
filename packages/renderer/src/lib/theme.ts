import { applyTokens, type ThemeTokens } from '@feathertree/base-ui';
import type { SettingsDto } from '@feathertree/ipc';

/**
 * FeatherTree のパレット。
 *
 * 適用の仕組み（style.setProperty で流し込む）は土台の applyTokens にある。
 * ここが持つのは「どんな色にするか」だけ。
 *
 * クラシック  — 無彩色のグレー基調（0.0.0 期からの配色）
 * フェザー — オレンジ味の緋色を基調にした配色（既定）
 */

type ThemeName = SettingsDto['theme'];

const CLASSIC_DARK: ThemeTokens = {
  '--app-bg-app': '#1b1d21',
  '--app-bg-surface': '#23262b',
  '--app-bg-raised': '#2b2f35',
  '--app-bg-hover': '#2f343b',
  '--app-bg-selected': '#33465c',
  '--app-border-subtle': '#33373d',
  '--app-border-strong': '#454b53',
  '--app-text-primary': '#e6e8ea',
  '--app-text-secondary': '#9ba1a8',
  '--app-text-muted': '#6f767e',
  '--app-text-added': '#7fce7f',
  '--app-text-removed': '#e07a7a',
  '--app-text-modified': '#d8c169',
  '--app-text-untracked': '#8ab4d8',
  '--app-text-conflict': '#e0a05c',
  '--app-text-danger': '#e05c5c',
  '--app-accent': '#5b9dd9',
  '--app-diff-added-bg': '#1e2f22',
  '--app-diff-removed-bg': '#33211f',
  '--app-bg-app-image': 'none',
  '--app-scheme': 'dark',
};

const CLASSIC_LIGHT: ThemeTokens = {
  '--app-bg-app': '#f5f6f7',
  '--app-bg-surface': '#ffffff',
  '--app-bg-raised': '#eceef0',
  '--app-bg-hover': '#e6e9ec',
  '--app-bg-selected': '#cfe0f2',
  '--app-border-subtle': '#dcdfe3',
  '--app-border-strong': '#b9bec5',
  '--app-text-primary': '#1f2328',
  '--app-text-secondary': '#5a6169',
  '--app-text-muted': '#8a9199',
  '--app-text-added': '#1a7f37',
  '--app-text-removed': '#c0392b',
  '--app-text-modified': '#9a6700',
  '--app-text-untracked': '#2b6cb0',
  '--app-text-conflict': '#bf6516',
  '--app-text-danger': '#c0392b',
  '--app-accent': '#2b6cb0',
  '--app-diff-added-bg': '#e6f6ea',
  '--app-diff-removed-bg': '#fdeceb',
  '--app-bg-app-image': 'none',
  '--app-scheme': 'light',
};

/**
 * フェザー（ダーク）。
 *
 * 背景そのものに緋を薄く混ぜる。模様（--app-bg-app-image）は起動のたびにランダムな
 * マーブル状のにじみになる。生成は下の generateMarbleBackground() を参照。
 * 緋色（accent）と削除・危険を表す赤が混ざらないよう、後者は薔薇寄りの赤にしている。
 */
const PHOENIX_DARK: ThemeTokens = {
  '--app-bg-app': '#1f1615',
  '--app-bg-surface': '#291d1b',
  '--app-bg-raised': '#332422',
  '--app-bg-hover': '#3e2b28',
  '--app-bg-selected': '#63301f',
  '--app-border-subtle': '#402d2a',
  '--app-border-strong': '#58403c',
  '--app-text-primary': '#f2e7e2',
  '--app-text-secondary': '#b39d96',
  '--app-text-muted': '#836d68',
  '--app-text-added': '#8cc47c',
  '--app-text-removed': '#ec7a8a',
  '--app-text-modified': '#dfb35d',
  '--app-text-untracked': '#8fb4d2',
  '--app-text-conflict': '#e79a55',
  '--app-text-danger': '#f4707c',
  '--app-accent': '#f2582c',
  '--app-diff-added-bg': '#23291d',
  '--app-diff-removed-bg': '#3d211f',
  '--app-bg-app-image': 'none',
  '--app-scheme': 'dark',
};

/** フェザー（ライト）。アプリの既定テーマ。 */
const PHOENIX_LIGHT: ThemeTokens = {
  '--app-bg-app': '#fbf3ef',
  '--app-bg-surface': '#fffcfa',
  '--app-bg-raised': '#f4e6df',
  '--app-bg-hover': '#eddbd2',
  '--app-bg-selected': '#fbcdba',
  '--app-border-subtle': '#e9d7ce',
  '--app-border-strong': '#c8ada2',
  '--app-text-primary': '#2a1c17',
  '--app-text-secondary': '#6a5049',
  '--app-text-muted': '#97817a',
  '--app-text-added': '#23763a',
  '--app-text-removed': '#b02a44',
  '--app-text-modified': '#8f6109',
  '--app-text-untracked': '#2f6aa8',
  '--app-text-conflict': '#b4560f',
  '--app-text-danger': '#b02a44',
  '--app-accent': '#d8441c',
  '--app-diff-added-bg': '#e9f4e6',
  '--app-diff-removed-bg': '#fbe6e0',
  '--app-bg-app-image': 'none',
  '--app-scheme': 'light',
};

/**
 * マーブル背景
 *
 * （臙脂〜淡い紅の 6 色）に、山吹金を 1 色加えた 7 色のにじみを大小ランダムな円で重ねて表現する。
 *
 * 起動ごとに 1 回だけ乱数で配置を決め（#cachedBlobs にキャッシュ）、同じセッション内で
 * テーマを行き来しても模様が飛ばないようにしている。位置は一様乱数ではなく、べき分布で
 * 右下（差分ペイン側）に確率的に寄せている（完全固定ではなく、たまに左上にも散る）。
 */
type MarbleMode = 'dark' | 'light';

/**
 * 緋色ベース+金
 */
const MARBLE_PALETTE: readonly string[] = [
  '#C9932E', // 山吹金（旧 Deepest Maroon）
  '#601020', // Dark Crimson
  '#601020', // Dark Crimson
  '#A02030', // Crimson Red
  '#C85064', // Rose Red
  '#C85064', // Rose Red
  '#C8788C', // Warm Pink
  // '#B48CA0', // Dusty Mauve
  // '#F0E1E1', // Pale Highlight
];

/**
 * 位置を右下へ寄せる強さ。1 なら一様分布、大きいほど右下（100% 側）に偏る。
 * Math.random() ** (1 / n) は指数 1/n < 1 になるほど 1 側に偏るべき分布になる。
 */
const BOTTOM_RIGHT_BIAS = 2.4;

interface MarbleBlob {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly colorIndex: number;
  readonly alpha01: number;
}

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${String((n >> 16) & 255)},${String((n >> 8) & 255)},${String(n & 255)}`;
}

/** 0〜100 の、右下（＝大きい値）側に確率的に偏った乱数。 */
function biasedCoordinate(): number {
  return 100 * Math.random() ** (1 / BOTTOM_RIGHT_BIAS);
}

function generateMarbleBlobs(): readonly MarbleBlob[] {
  const blobs: MarbleBlob[] = [];
  const count = 7 + Math.floor(Math.random() * 4); // 7〜10個
  for (let i = 0; i < count; i += 1) {
    blobs.push({
      cx: biasedCoordinate(),
      cy: biasedCoordinate(),
      r: 11 + Math.random() * 15,
      colorIndex: Math.floor(Math.random() * MARBLE_PALETTE.length),
      alpha01: Math.random(),
    });
  }
  return blobs;
}

let cachedBlobs: readonly MarbleBlob[] | null = null;

function marbleBlobs(): readonly MarbleBlob[] {
  cachedBlobs ??= generateMarbleBlobs();
  return cachedBlobs;
}

function generateMarbleBackground(mode: MarbleMode): string {
  const palette = MARBLE_PALETTE.map(hexToRgb);
  const [alphaMin, alphaMax] = mode === 'dark' ? [0.14, 0.32] : [0.08, 0.2];
  return marbleBlobs()
    .map((blob) => {
      const rgb = palette[blob.colorIndex];
      const alpha = (alphaMin + blob.alpha01 * (alphaMax - alphaMin)).toFixed(2);
      return `radial-gradient(circle at ${blob.cx.toFixed(1)}% ${blob.cy.toFixed(1)}%, rgba(${rgb},${alpha}) 0%, rgba(${rgb},0) ${blob.r.toFixed(1)}%)`;
    })
    .join(',');
}

const MARBLE_MODE_BY_THEME: Readonly<Partial<Record<ThemeName, MarbleMode>>> = {
  'phoenix-dark': 'dark',
  'phoenix-light': 'light',
};

export const THEMES: Readonly<Record<ThemeName, ThemeTokens>> = {
  'classic-dark': CLASSIC_DARK,
  'classic-light': CLASSIC_LIGHT,
  'phoenix-dark': PHOENIX_DARK,
  'phoenix-light': PHOENIX_LIGHT,
};

export interface ThemeOption {
  readonly value: ThemeName;
  readonly label: string;
}

/**
 * テーマ選択に出す並び。**系統ごとに 2 つずつ**（フェザー → クラシック）。
 *
 * 設定画面はこれを 2 列に、**列の向きに流し込む**ので、この順序がそのまま
 * 「左列＝フェザー 2 種 / 右列＝クラシック 2 種」になる。
 * 並べ替えるときは列の割れ方が変わることに注意（OptionsEnvironmentTab.svelte の .grid）。
 */
export const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: 'phoenix-dark', label: 'ダークモード（フェザー）' },
  { value: 'phoenix-light', label: 'ライトモード（フェザー）' },
  { value: 'classic-dark', label: 'ダークモード（クラシック）' },
  { value: 'classic-light', label: 'ライトモード（クラシック）' },
];

/** ダーク系かどうか。アイコンの出し分けに使う。 */
export function isDarkTheme(theme: ThemeName): boolean {
  return THEMES[theme]['--app-scheme'] === 'dark';
}

export function applyTheme(theme: ThemeName, root?: HTMLElement): void {
  const tokens = THEMES[theme];
  const marbleMode = MARBLE_MODE_BY_THEME[theme];
  const bgImage = marbleMode === undefined ? tokens['--app-bg-app-image'] : generateMarbleBackground(marbleMode);
  applyTokens(
    { ...tokens, '--app-bg-app-image': bgImage ?? 'none' },
    {
      ...(root === undefined ? {} : { root }),
      // color-scheme はダーク / ライトの 2 値。テーマ名そのものは渡せない。
      colorScheme: tokens['--app-scheme'] ?? 'light',
    },
  );
}
