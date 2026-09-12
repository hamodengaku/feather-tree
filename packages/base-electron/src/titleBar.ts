import type { BrowserWindow } from 'electron';

/**
 * フレームレスウィンドウのキャプション領域（OS が描く最小化 / 最大化 / 閉じる）の見た目。
 *
 * 土台としての意図: **ウィンドウ枠の色をアプリのテーマに追従させる**ための最小の口。
 * 色の決め方（どのテーマがどの色か）はアプリ側の知識なので、ここでは受け取るだけにする。
 */
export interface TitleBarChrome {
  /** キャプション領域の背景。アプリ側の 1 段目の背景色と揃えること（揃えないと継ぎ目が出る）。 */
  readonly color: string;
  /** ─ □ × の記号の色。 */
  readonly symbolColor: string;
  /** キャプション領域の高さ（px）。アプリ側の 1 段目の高さと揃えること。 */
  readonly height: number;
}

/**
 * BrowserWindow のコンストラクタに渡す `titleBarOverlay` の値。
 *
 * 併せて `titleBarStyle: 'hidden'` を指定すること（この指定が無いとオーバーレイは出ない）。
 * `frame: false` にはしない。枠の描画だけを消し、リサイズ枠・スナップ・ダブルクリック最大化は
 * OS に残すのがこのオーバーレイ方式の利点なので、それを捨てないため。
 */
export function titleBarOverlayOptions(chrome: TitleBarChrome): {
  color: string;
  symbolColor: string;
  height: number;
} {
  return { color: chrome.color, symbolColor: chrome.symbolColor, height: chrome.height };
}

/**
 * 既存ウィンドウのキャプション領域を塗り直す（テーマ切替時に呼ぶ）。
 *
 * 失敗しても本体の動作には影響させない。`setTitleBarOverlay` は Windows / Linux 専用で、
 * macOS やオーバーレイ無効のウィンドウでは例外になるため握りつぶす（metrics.ts と同じ方針）。
 */
export function applyTitleBarOverlay(window: BrowserWindow | null, chrome: TitleBarChrome): void {
  if (window === null || window.isDestroyed()) return;
  try {
    window.setTitleBarOverlay(titleBarOverlayOptions(chrome));
  } catch {
    // このプラットフォームにはキャプション領域のオーバーレイが無い。見た目だけの話なので無視する。
  }
}
