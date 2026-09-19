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
 *
 * 権限要求（カメラ・マイク等）は既定で全拒否する（脆弱性診断 §7 Low）。renderer は自作の
 * Svelte コードのみで、通常はこれらの Web API を呼ぶ経路が無いが、将来の実装ミス・依存の
 * 混入に備えて明示的に塞ぐ。例外はクローン完了ダイアログのコピーボタン（copyText、
 * `navigator.clipboard.writeText`）が使う 'clipboard-sanitized-write' のみ。読み取り
 * （'clipboard-read'）は使っていないので許可しない。
 *
 * このモジュールはスプラッシュ・本体の 2 つの BrowserWindow から呼ばれるが、両者は
 * session を分けていない（partition 未指定 = defaultSession 共有）ため、同じ session に
 * 対して setPermissionRequestHandler / setPermissionCheckHandler が 2 回呼ばれる。
 * どちらも「最後に設定した関数で上書き」なだけで、2 回とも同じ判定関数を渡すので実害は無い。
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

  const session = window.webContents.session;
  const isAllowed = (permission: string): boolean => permission === 'clipboard-sanitized-write';
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isAllowed(permission));
  });
  session.setPermissionCheckHandler((_webContents, permission) => isAllowed(permission));
}
