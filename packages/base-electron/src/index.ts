// 土台: main プロセス側。electron に依存する。
//
// アプリ固有の知識（このプロジェクトなら git）を一切持ち込まないこと。
export { ensureDir, isInstalledBuild, resolveTempDir, resolveUserDataDir } from './paths.js';
export type { AppPathOptions } from './paths.js';
export { hardenWindow } from './security.js';
export { applyTitleBarOverlay, titleBarOverlayOptions } from './titleBar.js';
export type { TitleBarChrome } from './titleBar.js';
export { HandlerError, createResultWrapper } from './ipcResult.js';
export { STARTUP_METRICS_FILE, writeStartupMetrics } from './metrics.js';
export type { StartupMetrics } from './metrics.js';
