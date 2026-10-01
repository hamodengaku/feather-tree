/**
 * macOS で PATH に補う、パッケージマネージャの既定の置き場。
 *
 *   /opt/homebrew/bin  Homebrew（Apple Silicon）
 *   /usr/local/bin     Homebrew（Intel）、公式インストーラ版の git / git-lfs
 */
const MAC_EXTRA_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin'];

/**
 * macOS の GUI 起動で欠ける PATH 要素を補った PATH を返す。macOS 以外では元の値をそのまま返す。
 *
 * Finder / Dock から起動したアプリはシェルの設定を読まないので、PATH が
 * `/usr/bin:/bin:/usr/sbin:/sbin` 程度しか無い。このままだと Homebrew で入れた git が
 * 見つからず、見つかった /usr/bin/git からも git-lfs や credential helper が見えない
 * （git は子プロセスを PATH から探す）。
 *
 * **先頭に足す**のは、ターミナルでの並び（Homebrew が /usr/bin より前）に揃えるため。
 * ログインシェルを起動して PATH を取り出す方法は採らない。起動のたびに外部プロセスの
 * 応答を待つことになり、シェルの設定次第で返ってこないこともある（gitLocator の
 * レジストリ照会と同じ種類の危険）。ここに無い場所の git は設定で明示指定できる。
 */
export function augmentPathForMac(
  path: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'darwin') return path;

  const current = path === undefined || path.length === 0 ? [] : path.split(':');
  const missing = MAC_EXTRA_DIRS.filter((dir) => !current.includes(dir));
  if (missing.length === 0) return path;
  return [...missing, ...current].join(':');
}
