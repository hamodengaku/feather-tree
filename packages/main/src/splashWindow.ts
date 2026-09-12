import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import { hardenWindow } from '@feathertree/base-electron';
import type { ThemeName } from '@feathertree/core';
import { WINDOW_BACKGROUND } from './windowChrome.js';

/**
 * 起動時のスプラッシュ（決定 28）。
 *
 * 本体ウィンドウが生まれる前の約 550ms、画面には何も出ない（重い処理を createWindow の
 * 前に済ませる作りのため）。そこを埋めるための別ウィンドウ。
 *
 * **IPC を 1 本も使わない。** 進捗は出さない方針なので、渡すのはテーマとバージョンだけで、
 * それはクエリ文字列で足りる。preload を持たせないことで最小権限を保つ。
 */

/**
 * スプラッシュの最低表示時間（ms）。
 *
 * 実測の `readyToShowMs` は 563ms（開発モード・1 タブ・ウォーム）。準備できた瞬間に消すと
 * 300ms 弱しか見えず、演出ではなく「何か光った」というちらつきに見える。
 * 1000ms あればロゴとバージョンを読み切れて、かつ待たされていると感じ始める前に消える。
 */
export const SPLASH_MIN_MS = 1000;

/** フェードアウトの長さ（ms）と刻み数。本体を出した後に重ねて落とすので、短くてよい。 */
const FADE_MS = 160;
const FADE_STEPS = 8;

/**
 * 起動処理が固まった場合の保険（ms）。
 *
 * 枠なし・常に手前・閉じるボタン無しなので、閉じ忘れるとユーザーに消す手段が無い。
 * どれだけ遅くてもこの時間で必ず閉じる。
 */
export const SPLASH_SAFETY_MS = 10_000;

export const SPLASH_WIDTH = 420;
export const SPLASH_HEIGHT = 260;

/**
 * 最低表示時間の残り（ms）。
 *
 * 純関数にしてあるのは、BrowserWindow を作らずにテストできるようにするため。
 * 時計が巻き戻って経過が負になっても、最低時間を超えて待たない。
 */
export function remainingHoldMs(shownAt: number, now: number, minMs: number = SPLASH_MIN_MS): number {
  const elapsed = now - shownAt;
  if (elapsed >= minMs) return 0;
  if (elapsed < 0) return minMs;
  return minMs - elapsed;
}

export function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * スプラッシュを作って**即座に出す**。
 *
 * 本体と違い `show: false` + `ready-to-show` を待たない。待ったら出す意味が無い。
 * 背景色を指定してあるので、中身が描かれる前の白いちらつきは起きない。
 */
export function createSplashWindow(theme: ThemeName, version: string): BrowserWindow {
  const window = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    show: true,
    center: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // 起動中だけの板。本体のアイコンと二重にタスクバーへ並べない
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: WINDOW_BACKGROUND[theme],
    title: 'FeatherTree',
    webPreferences: {
      // preload を渡さない。IPC を使わないので、渡すと権限を無駄に広げるだけになる
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      spellcheck: false,
    },
  });

  hardenWindow(window);

  const query = `?theme=${encodeURIComponent(theme)}&version=${encodeURIComponent(version)}`;
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl !== undefined) void window.loadURL(`${devUrl}/splash.html${query}`);
  else void window.loadFile(join(__dirname, '../renderer/splash.html'), { search: query });

  return window;
}

/**
 * 不透明度を刻んで落としてから閉じる。
 *
 * **呼ぶ前に本体ウィンドウを show() しておくこと。** 本体が下に見えている状態で落とすので、
 * デスクトップが覗く瞬間が無く、そのまま本体へ溶けるように見える。
 * 逆の順番だと `window-all-closed` が走ってアプリが終了する（決定 28）。
 */
export async function fadeOutAndClose(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) return;

  for (let step = 1; step <= FADE_STEPS; step += 1) {
    if (window.isDestroyed()) return;
    window.setOpacity(1 - step / FADE_STEPS);
    await delay(FADE_MS / FADE_STEPS);
  }

  if (!window.isDestroyed()) window.close();
}
