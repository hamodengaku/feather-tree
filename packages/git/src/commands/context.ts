/**
 * 1 コマンド実行に必要な文脈。呼び出し側（core 層）が組み立てる。
 * git 層はここに書かれた値だけを使い、環境から勝手に何かを読まない。
 */
export interface GitContext {
  /** git.exe の絶対パス。 */
  readonly gitPath: string;
  /** 実行時の作業ディレクトリ（リポジトリルート）。 */
  readonly cwd: string;
  /** 一時ファイルの置き場。os.tmpdir() を直接使わず注入する。 */
  readonly tempDir: string;
  readonly signal?: AbortSignal;
}
