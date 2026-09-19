import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { app } from 'electron';

/**
 * userData と一時ファイルの置き場を決める。
 *
 * 土台としての方針: **既定の %APPDATA% は、インストール版のときだけ使う。** それ以外は
 * リポジトリ外・インストール先の外へ書かないことを優先する。
 *   1. zip 展開版・開発時は exe の隣（開発時はリポジトリ内）に置き、フォルダごと
 *      持ち運べる完全ポータブル配布を成立させる
 *   2. インストール版はインストール先（`%LOCALAPPDATA%\Programs\...` 相当）が上書きインストール／
 *      アンインストールで消えるため、そこには置けない。Electron 既定の `%APPDATA%\<productName>`
 *      をそのまま使う（`app.setPath` で上書きしない）
 *
 * 判定は「パッケージ済みで、exe と同じディレクトリにアンインストーラが存在するか」で行う
 * （`isInstalledBuild`）。`release/win-unpacked` にはアンインストーラが無いので zip 版として
 * 扱われ、userData はリポジトリ内の `release/win-unpacked/<dataDirName>` に収まる。
 *
 * `app.setPath('userData', ...)` は `app.whenReady()` より前に呼ぶ必要がある
 * （Chromium のキャッシュ位置もこれに従うため）。
 */
export interface AppPathOptions {
  /** exe の隣・リポジトリ内に作るデータディレクトリ名（例: MyApp-data）。 */
  readonly dataDirName: string;
  /** 開発時にデータを置くリポジトリ内の相対パス（既定: .cache/userdata）。 */
  readonly devRelativeDir?: string;
  /** 開発時に一時ファイルを置くリポジトリ内の相対パス（既定: .tmp/runtime）。 */
  readonly devTempRelativeDir?: string;
  /**
   * アンインストーラのファイル名（既定: `Uninstall <exe のベース名>.exe`）。
   * NSIS の一般的な命名（`Uninstall ${productName}.exe`）は exe 名（通常 productName と同じ）
   * から導出できるため、既定値だけで大抵のアプリに対応できる。`executableName` を
   * `productName` と別に設定している場合のみ明示する。
   */
  readonly uninstallerFileName?: string;
}

/** NSIS の既定命名から `Uninstall <exe のベース名>.exe` を組み立てる。 */
function defaultUninstallerFileName(exePath: string): string {
  return `Uninstall ${basename(exePath, extname(exePath))}.exe`;
}

/**
 * インストール版か zip 展開版かを判定する純関数。
 *
 * `exists` を注入できるようにしてあるのは、実ファイルシステムに触れずにテストするため
 * （`existsSync` だけだと本物のファイルの有無しか見られず、ケースを作りにくい）。
 */
export function isInstalledBuild(
  exeDir: string,
  uninstallerFileName: string,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return exists(join(exeDir, uninstallerFileName));
}

export function resolveUserDataDir(options: AppPathOptions): string {
  if (app.isPackaged) {
    const exePath = app.getPath('exe');
    const exeDir = dirname(exePath);
    const uninstallerFileName = options.uninstallerFileName ?? defaultUninstallerFileName(exePath);

    // インストール版: インストール先（%LOCALAPPDATA%\Programs\... 相当）は上書きインストールや
    // アンインストールで中身が消えるため exe の隣には置けない。Electron 既定を使う
    if (isInstalledBuild(exeDir, uninstallerFileName)) return app.getPath('userData');

    // zip 展開版: 従来どおり exe の隣（release/win-unpacked はここに来る）
    return join(exeDir, options.dataDirName);
  }

  // 開発時はリポジトリ内に閉じる
  return join(app.getAppPath(), ...(options.devRelativeDir ?? '.cache/userdata').split('/'));
}

/**
 * 一時ファイルの置き場。開発時は os.tmpdir() を使わずリポジトリ内に閉じる。
 * インストール版でも zip 展開版と同じく userData 配下の `tmp`（%APPDATA% の中に収まる）。
 */
export function resolveTempDir(options: AppPathOptions): string {
  if (app.isPackaged) return join(resolveUserDataDir(options), 'tmp');
  return join(app.getAppPath(), ...(options.devTempRelativeDir ?? '.tmp/runtime').split('/'));
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
