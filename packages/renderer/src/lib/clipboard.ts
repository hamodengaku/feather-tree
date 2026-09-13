/**
 * クリップボードへの書き込み。失敗しても例外にせず false を返す（呼び出し側は「コピーできませんでした」と出すだけ）。
 * main に権限ハンドラを置いていないので、Electron の既定どおり renderer から書ける（読み取りはしない）。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
