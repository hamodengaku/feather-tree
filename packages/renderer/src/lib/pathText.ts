/**
 * コピー用のパス文字列（右クリックメニューの「ファイル名をコピー」「フルパスをコピー」）。
 *
 * renderer は Node の path を使えない（依存規則）ので、git のパス（区切りは常に '/'）と
 * リポジトリルートの文字列だけで組み立てる。
 */

const BACKSLASH = String.fromCharCode(92);

/** 末尾の要素（ファイル名）。 */
export function fileNameOf(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * リポジトリルート + 相対パスの絶対パス。
 *
 * ルートが Windows のパス（ドライブ文字か '\' を含む）なら区切りを '\' に揃える。
 * エクスプローラーやエディタへそのまま貼れる形にするため。
 */
export function fullPathOf(root: string, path: string): string {
  const windows = /^[A-Za-z]:/.test(root) || root.includes(BACKSLASH);
  const sep = windows ? BACKSLASH : '/';
  const joined = (root.endsWith('/') || root.endsWith(BACKSLASH) ? root.slice(0, -1) : root) + '/' + path;
  return windows ? joined.split('/').join(sep) : joined;
}
