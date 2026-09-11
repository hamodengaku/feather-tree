import { shell, type BrowserWindow } from 'electron';

/**
 * ウィンドウの安全設定。
 *
 * 土台としての方針: **外部への遷移とウィンドウ生成を全面的に禁止する。**
 * 外部リンクは https のみ既定ブラウザへ委譲し、webview の埋め込みも拒否する。
 *
 * 例外: リポジトリ配下のファイル・フォルダを OS 既定のアプリで開くことは許可する
 * （shell.openPath / shell.showItemInFolder）。これは「ウィンドウの中に外部の何かを
 * 読み込む」のとは別物で、パスは main 側で assertInsideRoot を通してから渡す。
 *
 * BrowserWindow 側では別途これらを必ず指定すること:
 *   contextIsolation: true / nodeIntegration: false / sandbox: true / webSecurity: true
 * さらに index.html の meta で CSP を設定する。
 */
export function hardenWindow(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event, url) => {
    // renderer 内部のリロードのみ許可し、それ以外の遷移は拒否する
    if (url !== window.webContents.getURL()) event.preventDefault();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    // 新規ウィンドウは一切開かせない。https のみ既定ブラウザへ委譲する
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}
