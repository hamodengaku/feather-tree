import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';

/**
 * userData と一時ファイルの置き場を決める。
 *
 * 土台としての方針: **既定の %APPDATA% を使わない。** 理由は 2 つ。
 *   1. 完全ポータブル配布（設定は exe と同じ場所に置く）を成立させる
 *   2. 開発時にリポジトリ外へファイルを書かない
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
}

export function resolveUserDataDir(options: AppPathOptions): string {
  // electron-builder の portable ターゲットは exe のあるディレクトリをこの変数で渡す
  const portableDir = process.env['PORTABLE_EXECUTABLE_DIR'];
  if (portableDir !== undefined && portableDir.length > 0) {
    return join(portableDir, options.dataDirName);
  }

  // zip 展開版など、パッケージ済みだが portable ではない場合は exe の隣
  if (app.isPackaged) return join(dirname(app.getPath('exe')), options.dataDirName);

  // 開発時はリポジトリ内に閉じる
  return join(app.getAppPath(), ...(options.devRelativeDir ?? '.cache/userdata').split('/'));
}

/** 一時ファイルの置き場。開発時は os.tmpdir() を使わずリポジトリ内に閉じる。 */
export function resolveTempDir(options: AppPathOptions): string {
  if (app.isPackaged) return join(resolveUserDataDir(options), 'tmp');
  return join(app.getAppPath(), ...(options.devTempRelativeDir ?? '.tmp/runtime').split('/'));
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
