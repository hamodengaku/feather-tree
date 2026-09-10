import { join } from 'node:path';
import { app, BrowserWindow, Menu } from 'electron';
import { CHANNELS, type FocusRefreshPromptEvent, type SessionChangedEvent } from '@feathertree/ipc';
import { AppContext } from './appContext.js';
import { registerHandlers } from './handlers/register.js';
import { hardenWindow, writeStartupMetrics } from '@feathertree/base-electron';

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
 */
function resolveWindowIcon(): string | undefined {
  if (app.isPackaged) return undefined;
  return join(app.getAppPath(), 'build', 'icon-app.png');
}

/**
 * 最初のペイントで白／黒がちらつかないよう、ウィンドウ背景をテーマに合わせる。
 * 値は renderer の lib/theme.ts の --app-bg-app と対になっている。
 */
const WINDOW_BACKGROUND = {
  'classic-dark': '#1b1d21',
  'classic-light': '#f5f6f7',
  'phoenix-dark': '#1f1615',
  'phoenix-light': '#fbf3ef',
} as const satisfies Record<string, string>;

let mainWindow: BrowserWindow | null = null;
let appReadyMs = 0;

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

  window.once('ready-to-show', () => {
    const readyToShowMs = Date.now() - processStart;
    window.show();
    writeStartupMetrics(context.userDataDir, { appReadyMs, readyToShowMs });
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
  await context.initialize();
  await context.restoreSessions();
  registerHandlers(context, () => mainWindow);
  mainWindow = createWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
});
