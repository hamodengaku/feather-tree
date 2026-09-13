/*
 * クローンダイアログの入力補助（純関数）。
 * renderer は node:path を使えないので、区切りは `/` と `\` の両方を自前で扱う。
 */

/** Windows のフォルダ名に使えない文字。main 側の検証と同じ集合（制御文字は hasControlChar で見る）。 */
const INVALID_NAME = /[\\/:*?"<>|]/;

/** `https://` `ssh://` `file://` など、scheme 付きの URL。 */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Windows のドライブ直下（`D:\` / `D:/`）。 */
const DRIVE_ROOT = /^[a-z]:[\\/]/i;
/** パス先頭のドライブ名（`file:///D:/...` の `D:`）。フォルダ名にはしない。 */
const LEADING_DRIVE = /^[\\/]?[a-z]:(?=[\\/]|$)/i;
/** ssh の scp 形式（`user@host:パス`）。`:` より前に区切りが無い。 */
const SCP = /^[^\\/:]+:/;

/** 正規表現に制御文字を書くと lint（no-control-regex）に掛かるので、文字コードで見る。 */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * URL のうち「アドレス段階」を越えた後ろのパス部分。
 * まだアドレス段階なら null、どの形にも当たらなければ undefined。
 */
function pathPart(url: string): string | null | undefined {
  const scheme = SCHEME.exec(url);
  if (scheme !== null) {
    // ホスト（ポートの `:` を含む）の後ろの区切りを越えるまではアドレス
    const rest = url.slice(scheme[0].length);
    const slash = rest.search(/[\\/]/);
    return slash < 0 ? null : rest.slice(slash + 1);
  }
  // `D:` だけの段階は下の SCP に当たり、パスが空なので空文字になる
  if (DRIVE_ROOT.test(url)) return url.slice(3);
  const scp = SCP.exec(url);
  if (scp !== null) return url.slice(scp[0].length);
  return undefined;
}

function nameFromPath(path: string): string {
  const segments = path
    .replace(LEADING_DRIVE, '')
    .split(/[\\/]+/)
    .filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? '';
  // `.git` を外す。打ちかけの `.` / `.g` / `.gi` も隠す（入力途中に名前が揺れないように）
  const name = last.replace(/\.git$/i, '').replace(/\.(gi?)?$/i, '');
  // 末尾のドットや空白は Windows のフォルダ名に使えない（main の検証と同じ）
  if (name.length === 0 || INVALID_NAME.test(name) || hasControlChar(name) || /[. ]$/.test(name)) return '';
  return name;
}

/**
 * URL からフォルダ名を補完する（git が `git clone <url>` で自動で掘る名前に合わせる）。
 *
 * 入力途中に揺れないよう、アドレス段階では空文字を返す:
 *  - ssh（`user@host:パス`）は `:` を越えてから
 *  - `https://` など scheme 付きは、ホストの後ろの `/` を越えてから（ポートの `:` はアドレス扱い）
 *  - Windows のパスは、ドライブ直下の区切りを越えてから
 * どの形にも当たらないもの（`\\server\share\repo` 等）は、入力が確定したとき
 * （committed: 貼り付け・ドロップ・欄から離れた）だけ補完する。
 */
export function folderNameFromUrl(url: string, committed: boolean): string {
  const trimmed = url.trim();
  const path = pathPart(trimmed);
  if (path === null) return '';
  if (path !== undefined) return nameFromPath(path);
  // 区切りを含まない段階（`git@github.co` のような打ちかけのアドレス）は、確定しても補完しない
  if (!committed || !/[\\/]/.test(trimmed)) return '';
  return nameFromPath(trimmed);
}

/**
 * 1 つ上のフォルダ。保存先の初期値（開いているリポジトリの隣）に使う。
 * ドライブ直下なら `D:/` のように区切りを残す（`D:` だけではカレントディレクトリ相対になる）。
 */
export function parentOf(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index < 0) return '';
  const parent = trimmed.slice(0, index);
  const separator = trimmed.charAt(index);
  if (parent.length === 0) return separator;
  return parent.endsWith(':') ? parent + separator : parent;
}

/**
 * 作成先の表示用。どちらかが空なら空文字。
 * main は node:path の join で作るので、Windows のパスは `\` にそろう。表示もそれに合わせる。
 */
export function joinPreview(parent: string, name: string): string {
  const base = parent.trim();
  const leaf = name.trim();
  if (base.length === 0 || leaf.length === 0) return '';
  const windows = /^[a-z]:/i.test(base) || base.includes('\\');
  const head = (windows ? base.replace(/\//g, '\\') : base).replace(/[\\/]+$/, '');
  return head + (windows ? '\\' : '/') + leaf;
}
