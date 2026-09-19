import { join } from 'node:path';
import { app, BrowserWindow, Menu } from 'electron';
import {
  CHANNELS,
  type CommandEndEvent,
  type CommandStartEvent,
  type FocusRefreshPromptEvent,
  type SessionChangedEvent,
} from '@feathertree/ipc';
import type { CommandLogEntry } from '@feathertree/core';
import { AppContext } from './appContext.js';
import { toCommandLogEntryDto } from './handlers/commandLogDto.js';
import { registerHandlers } from './handlers/register.js';
import { STARTUP_UPDATE_CHECK_DELAY_MS, registerUpdateHandlers } from './handlers/update.js';
import { hardenWindow, titleBarOverlayOptions, writeStartupMetrics } from '@feathertree/base-electron';
import { WINDOW_BACKGROUND, chromeFor } from './windowChrome.js';
import {
  SPLASH_SAFETY_MS,
  createSplashWindow,
  delay,
  fadeOutAndClose,
  remainingHoldMs,
} from './splashWindow.js';

const processStart = Date.now();

// app.whenReady() より前に呼ぶ必要がある（Chromium のキャッシュ位置もこれに従う）。
// 既定の %APPDATA% は使わない（docs/01-architecture.md 10 章）。
const context = new AppContext();
app.setPath('userData', context.userDataDir);

/**
 * 開発モードのウィンドウアイコン。
 *
 * パッケージ済みの exe にはアイコンが埋め込まれているので指定不要。
 * 開発時は指定しないと Electron の既定アイコンが出るので、build/ から読む
 * （build/ は files に含めていないため、パッケージ後は存在しない）。
 *
 * 配布物と同じ絵を見るため、マスター（icon-app.png）ではなく
 * 実際に .ico へ入る素材（build/icon/256.png）を読む。
 */
function resolveWindowIcon(): string | undefined {
  if (app.isPackaged) return undefined;
  return join(app.getAppPath(), 'build', 'icon', '256.png');
}

let mainWindow: BrowserWindow | null = null;
let appReadyMs = 0;

/**
 * 更新通知（決定 29）の起動時チェック。null なら未登録（起動処理が途中で失敗した場合等）。
 * handOverToMainWindow から呼ぶので、登録は app.whenReady 内の try ブロックで行う。
 */
let runStartupUpdateCheck: (() => Promise<void>) | null = null;

/**
 * スプラッシュ（決定 28）。起動中だけ存在する。
 *
 * 閉じる経路が 3 つある（正常終了・起動処理の失敗・保険タイマー）ので、
 * 二重に閉じないよう handOverToMainWindow() の 1 箇所に集約する。
 */
let splashWindow: BrowserWindow | null = null;
let splashShownAt = 0;
let splashShownMs: number | undefined;
let splashSafetyTimer: NodeJS.Timeout | null = null;
let handedOver = false;

/**
 * スプラッシュから本体へ渡す。
 *
 * **順番が重要**: 本体を show() してからスプラッシュを閉じる。
 * 逆にすると、本体が無い瞬間に `window-all-closed` が走ってアプリが終了する
 * （docs/01-architecture.md 11 章）。
 */
async function handOverToMainWindow(): Promise<void> {
  if (handedOver) return;
  handedOver = true;

  if (splashSafetyTimer !== null) {
    clearTimeout(splashSafetyTimer);
    splashSafetyTimer = null;
  }

  const splash = splashWindow;
  splashWindow = null;

  // スプラッシュを出していた時間が最低表示時間に届いていなければ、その分だけ待つ
  if (splash !== null && !splash.isDestroyed()) {
    await delay(remainingHoldMs(splashShownAt, Date.now()));
  }

  const window = mainWindow;
  if (window !== null && !window.isDestroyed()) {
    window.show();
    const windowShownMs = Date.now() - processStart;
    writeStartupMetrics(context.userDataDir, {
      appReadyMs,
      readyToShowMs,
      ...(splashShownMs === undefined ? {} : { splashShownMs }),
      windowShownMs,
    });

    /*
     * 更新通知（決定 29）: 本体ウィンドウ表示後に、数秒待ってから 1 回だけ確認する。
     * setTimeout にしてあるのは、show() 直後の重い時間帯とネットワーク処理を重ねないため
     * （決定 28 の起動を 1ms も遅らせない、という制約はここまでで満たしている）。
     */
    const startupCheck = runStartupUpdateCheck;
    if (startupCheck !== null) {
      setTimeout(() => void startupCheck(), STARTUP_UPDATE_CHECK_DELAY_MS);
    }
  }

  if (splash !== null) await fadeOutAndClose(splash);
}

let readyToShowMs = 0;

function createWindow(): BrowserWindow {
  const settings = context.currentSettings();
  const icon = resolveWindowIcon();

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: WINDOW_BACKGROUND[settings.theme],
    title: 'FeatherTree',
    /*
     * 決定 24: OS のタイトル行を消し、その高さを renderer のタブ段が受け取る。
     * 'hidden' は枠の描画だけを消す指定で、frame: false とは違いリサイズ枠・Snap Layouts・
     * ダブルクリック最大化は OS 側に残る。最小化 / 最大化 / 閉じるも OS が右上へ描き続けるため、
     * ウィンドウ操作用の IPC を持たなくて済む。色はテーマ切替時に register.ts が塗り直す。
     */
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlayOptions(chromeFor(settings.theme)),
    ...(icon === undefined ? {} : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
      spellcheck: false,
      backgroundThrottling: true,
    },
  });

  hardenWindow(window);

  /*
   * show() はここでは呼ばない（決定 28）。
   * スプラッシュの最低表示時間を待ってから出すので、引き渡しに任せる。
   * readyToShowMs は「表示できるようになった時刻」として、実際に見えた時刻とは別に記録する。
   */
  window.once('ready-to-show', () => {
    readyToShowMs = Date.now() - processStart;
    void handOverToMainWindow();
  });

  /**
   * 決定 14: 自動更新はウィンドウ復帰時と手動のみ。
   * ポーリングもファイル監視もしない。ここが唯一の自動的な入口。
   *
   * refocusUpdateMode で分岐する: 'auto' は従来通り無条件で更新、'none' は何もしない
   * （手動更新ボタンのみ）、'modal' は自動更新せず renderer に確認を委ねる
   * （renderer が「更新する」を選んだときだけ既存の手動更新経路 sessionRefresh を呼ぶ）。
   * いずれもウィンドウフォーカスが唯一の入口であることは変わらず、ポーリングは増えない。
   */
  window.on('focus', () => {
    const sessions = context.sessions();
    const activeId = sessions?.activeId;
    if (sessions === null || activeId === null || activeId === undefined) return;

    const mode = context.currentSettings().refocusUpdateMode;
    if (mode === 'none') return;
    if (mode === 'modal') {
      notifyFocusRefreshPrompt(activeId);
      return;
    }
    void sessions.requestStatusRefresh(activeId).then(
      () => notifySessionChanged(activeId),
      () => undefined,
    );
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl !== undefined) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));

  return window;
}

function notifySessionChanged(sessionId: string): void {
  const sessions = context.sessions();
  const session = sessions?.get(sessionId) ?? null;
  if (session === null || mainWindow === null || mainWindow.isDestroyed()) return;

  const event: SessionChangedEvent = {
    sessionId,
    change: 'status',
    statusSeq: session.statusSeq,
  };
  mainWindow.webContents.send(CHANNELS.eventSessionChanged, event);
}

/**
 * git の実行開始と終了をコマンドバーへ送る（決定 26）。
 * 発火点は RepositorySession.track() の 1 箇所だけ。
 */
function notifyCommandStart(event: CommandStartEvent): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(CHANNELS.eventCommandStart, event);
}

function notifyCommandEnd(opId: string): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  const event: CommandEndEvent = { opId };
  mainWindow.webContents.send(CHANNELS.eventCommandEnd, event);
}

/**
 * コマンドログに 1 件増えたことを実行ログパネルへ送る（全タブ分）。
 * 発火点は CommandLog.add なので、track() を通る実行もクローンも同じ経路で届く。
 */
function notifyCommandLogged(entry: CommandLogEntry): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(CHANNELS.eventCommandLogged, toCommandLogEntryDto(entry));
}

function notifyFocusRefreshPrompt(sessionId: string): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  const event: FocusRefreshPromptEvent = { sessionId };
  mainWindow.webContents.send(CHANNELS.eventFocusRefreshPrompt, event);
}

app.on('window-all-closed', () => {
  app.quit();
});

void app.whenReady().then(async () => {
  appReadyMs = Date.now() - processStart;
  // Electron 既定のメニュー（File / Edit / View / Window）は git クライアントには不要。
  // 縦の表示領域を無駄にするので出さない。
  Menu.setApplicationMenu(null);

  /*
   * スプラッシュ（決定 28）を最優先で出す。
   *
   * 設定の読み込みだけ先に済ませる（JSON 1 本なので速い）。テーマに合わせた背景色で
   * 出したいので設定が要るが、この後の git 探索やタブ復元を待つ必要は無い。
   */
  await context.loadSettings();
  splashWindow = createSplashWindow(context.currentSettings().theme, app.getVersion());
  splashShownAt = Date.now();
  splashShownMs = splashShownAt - processStart;
  // 起動処理が固まっても、閉じるボタンの無い板が残り続けないようにする
  splashSafetyTimer = setTimeout(() => void handOverToMainWindow(), SPLASH_SAFETY_MS);

  try {
    await context.initialize();
    await context.restoreSessions();
    context.onCommandStart = notifyCommandStart;
    context.onCommandEnd = notifyCommandEnd;
    context.commandLog.onAdd(notifyCommandLogged);
    registerHandlers(context, () => mainWindow);
    runStartupUpdateCheck = registerUpdateHandlers(context, () => mainWindow).runStartupCheck;
    mainWindow = createWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  } catch (err) {
    /*
     * 起動処理が投げてもスプラッシュは必ず閉じる。
     * ここで閉じないと、枠なし・常に手前・閉じるボタン無しの板だけが残る。
     * 本体ウィンドウが無い状態で閉じるとアプリは終了するが、
     * 起動に失敗しているのだからそれが正しい振る舞い。
     */
    await handOverToMainWindow();
    throw err;
  }
});
