import type { ThemeName } from '@feathertree/core';
import type { TitleBarChrome } from '@feathertree/base-electron';

/**
 * ウィンドウ枠まわりの色と寸法。
 *
 * **値は renderer の `lib/theme.ts` のトークンと対になっている。**
 * あちらを変えたらここも変えること（main プロセスは CSS 変数を読めないので複製が要る）。
 */

/**
 * 最初のペイントで白／黒がちらつかないようにするウィンドウ背景。`--app-bg-app` と対。
 */
export const WINDOW_BACKGROUND = {
  'classic-dark': '#1b1d21',
  'classic-light': '#f5f6f7',
  'phoenix-dark': '#1f1615',
  'phoenix-light': '#fbf3ef',
} as const satisfies Record<ThemeName, string>;

/**
 * キャプション領域（OS が描く ─ □ ×）の色。決定 24。
 *
 * `color` は `--app-bg-raised`（= タブ段の背景）、`symbolColor` は `--app-text-primary` と対。
 * タブ段と同じ色にしないと、アプリが描く部分と OS が描く部分の境目に継ぎ目が出る。
 */
export const WINDOW_CHROME = {
  'classic-dark': { color: '#2b2f35', symbolColor: '#e6e8ea' },
  'classic-light': { color: '#eceef0', symbolColor: '#1f2328' },
  'phoenix-dark': { color: '#332422', symbolColor: '#f2e7e2' },
  'phoenix-light': { color: '#f4e6df', symbolColor: '#2a1c17' },
} as const satisfies Record<ThemeName, { color: string; symbolColor: string }>;

/**
 * タブ段の高さ（px）。
 *
 * **`packages/renderer/src/theme/tokens.css` の `--app-metric-tabbar-height` と必ず同じ値にする。**
 * OS が描くボタンの高さがこの値になるので、片方だけ変えるとタブ段とボタンの間に段差が出る。
 */
export const TITLE_BAR_HEIGHT = 34;

export function chromeFor(theme: ThemeName): TitleBarChrome {
  return { ...WINDOW_CHROME[theme], height: TITLE_BAR_HEIGHT };
}
