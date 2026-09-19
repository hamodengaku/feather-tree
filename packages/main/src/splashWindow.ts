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
 * スプラッシュから本体への引き渡しを起こす出来事。
 *
 * - `main-ready` — 本体の `ready-to-show`。正常な経路
 * - `safety-timer` — 保険タイマー（SPLASH_SAFETY_MS）が鳴った。**スプラッシュしか閉じない**
 * - `startup-failed` — 起動処理が投げた。板を残さず、出せるものは出す
 */
export type HandoverTrigger = 'main-ready' | 'safety-timer' | 'startup-failed';

/** 今回の呼び出しで実際に行うこと。どちらも false なら何もしない。 */
export interface HandoverActions {
  /** 本体ウィンドウを `show()` するか。 */
  readonly showMain: boolean;
  /** スプラッシュをフェードアウトして閉じるか。 */
  readonly closeSplash: boolean;
}

/**
 * 引き渡しのラッチ（docs/01-architecture.md 11 章 2026-09-19 追加分）。
 *
 * **ラッチを 1 つにしてはいけない。** 「引き渡し済み」という 1 つのフラグにまとめると、
 * 保険タイマーが先に鳴ってスプラッシュだけを閉じた後、遅れて来た `ready-to-show` が
 * 即 return してしまい、`show: false` のまま**見えないウィンドウを抱えたプロセスが常駐**する。
 *
 * そこで「スプラッシュを閉じた」と「本体を出した」を別々に持ち、
 * まだ済んでいないほうだけを、来た出来事に応じて実行する。
 *
 * index.ts は Electron に強く依存していてテストから叩けないので、
 * **判断だけをここへ切り出す**（BrowserWindow を作らずに検証できる）。
 */
export class HandoverLatch {
  #splashClosed = false;
  #mainShown = false;

  /** スプラッシュを閉じ終えた（あるいは閉じると決めた）か。 */
  get splashClosed(): boolean {
    return this.#splashClosed;
  }

  /** 本体を `show()` した（あるいは出すと決めた）か。 */
  get mainShown(): boolean {
    return this.#mainShown;
  }

  /**
   * 今回行うことを決め、ラッチを立てる。同じことを二度返さない。
   *
   * @param trigger どの経路から来たか
   * @param hasMainWindow 本体ウィンドウが存在して生きているか
   *
   * 保険タイマーは**本体を出さない**。まだ `ready-to-show` すら来ていない
   * （＝中身が描けていない）ウィンドウを出しても白い板になるだけで、
   * 出すべき瞬間は後から来る `main-ready` が知っている。
   * 本体が無くてもスプラッシュは閉じる——閉じるボタンの無い板を残さないことが最優先で、
   * 本体が無い状態で閉じればアプリは終了するが、起動に失敗しているならそれが正しい。
   */
  decide(trigger: HandoverTrigger, hasMainWindow: boolean): HandoverActions {
    const showMain = !this.#mainShown && hasMainWindow && trigger !== 'safety-timer';
    const closeSplash = !this.#splashClosed;

    if (showMain) this.#mainShown = true;
    if (closeSplash) this.#splashClosed = true;

    return { showMain, closeSplash };
  }
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
