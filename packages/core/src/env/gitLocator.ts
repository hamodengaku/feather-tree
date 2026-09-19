import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { defaultExists, findOnPath, systemRoot } from './pathSearch.js';

/** PATH 上で探す git の名前。 */
const GIT_NAMES: readonly string[] = process.platform === 'win32' ? ['git.exe'] : ['git'];

export type GitSource = 'configured' | 'path' | 'registry';

export interface GitLocation {
  readonly gitPath: string;
  readonly source: GitSource;
}

export interface GitLocatorDeps {
  /** 設定画面で明示指定されたパス。 */
  readonly configuredPath?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  /** テストから差し替えられるようにしておく。 */
  readonly exists?: (path: string) => Promise<boolean>;
  readonly queryRegistry?: () => Promise<string | null>;
}

/**
 * git.exe を探す。docs/01-architecture.md 5 章の順序に従う。
 *   ①設定の明示パス → ②PATH 走査 → ③レジストリ
 *
 * 結果は呼び出し側で 1 回だけ解決してキャッシュする（毎回探索しない）。
 * 見つからなければ null。導入案内は上位層の責務。
 */
export async function locateGit(deps: GitLocatorDeps): Promise<GitLocation | null> {
  const exists = deps.exists ?? defaultExists;

  /*
   * 設定の明示パスも**絶対パスでなければ採らない**（2026-09-19 追加、診断 1-A）。
   *
   * 相対パスを許すと、存在確認（access）はプロセスの cwd 基準で行われるのに、
   * 実行は spawn の `cwd: リポジトリルート` 基準になり、**確認したファイルと
   * 起動されるファイルが別物になりうる**。PATH 要素に同じ規則を課しているのに
   * ここだけ素通しでは意味が無いので揃える。
   * 弾いた場合はエラーにせず PATH 探索へ落とす（設定の不正値で起動を止めない方針）。
   */
  if (deps.configuredPath !== undefined && isAbsolute(deps.configuredPath)) {
    if (await exists(deps.configuredPath)) {
      return { gitPath: deps.configuredPath, source: 'configured' };
    }
  }

  const fromPath = await findOnPath(GIT_NAMES, deps.env, exists);
  if (fromPath !== null) return { gitPath: fromPath, source: 'path' };

  const queryRegistry = deps.queryRegistry ?? queryGitForWindowsRegistry;
  const installPath = await queryRegistry();
  if (installPath !== null) {
    for (const candidate of [join(installPath, 'cmd', 'git.exe'), join(installPath, 'bin', 'git.exe')]) {
      if (await exists(candidate)) return { gitPath: candidate, source: 'registry' };
    }
  }

  return null;
}

/**
 * HKLM\SOFTWARE\GitForWindows の InstallPath を読む。reg query を 1 回だけ実行する。
 *
 * `reg` を bare 名で spawn すると、cwd 検索の対象になる（1-B, Low）。ここは cwd を
 * 指定しない spawn なのでアプリの起動ディレクトリが対象になり、リポジトリからは直接
 * 到達できないが、念のため `%SystemRoot%\System32\reg.exe` の絶対パスに固定する。
 */
function queryGitForWindowsRegistry(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);

  const regPath = join(systemRoot(process.env), 'System32', 'reg.exe');

  return new Promise((resolve) => {
    const child = spawn(regPath, ['query', 'HKLM' + String.fromCharCode(92) + 'SOFTWARE' + String.fromCharCode(92) + 'GitForWindows', '/v', 'InstallPath'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const m = /InstallPath\s+REG_SZ\s+(.+)/.exec(out);
      const value = m?.[1]?.trim();
      resolve(value !== undefined && value.length > 0 ? value : null);
    });
  });
}
