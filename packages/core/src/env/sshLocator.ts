import { dirname, join } from 'node:path';
import { defaultExists, findOnPath, systemRoot } from './pathSearch.js';

/** PATH 上で探す ssh の名前。 */
const SSH_NAMES: readonly string[] = process.platform === 'win32' ? ['ssh.exe'] : ['ssh'];

export interface SshLocatorDeps {
  readonly env: NodeJS.ProcessEnv;
  /** git.exe のパス。Git 同梱の ssh を導くために使う。未検出なら null。 */
  readonly gitPath: string | null;
  /** テストから差し替えられるようにしておく。 */
  readonly exists?: (path: string) => Promise<boolean>;
}

/**
 * `GIT_SSH_COMMAND` に埋める ssh の**絶対パス**を決める（決定 13 の追記）。
 *
 * **bare 名の `ssh` を渡さないことが目的。** git は `GIT_SSH_COMMAND` を
 * シェルのコマンド文字列として解釈するので、bare 名だと実行時の PATH 次第で
 * どの ssh が動くか変わる。診断 1-A / 1-B で `wt.exe` / `powershell.exe` / `reg` を
 * 絶対パスへ統一したのと同じ規則をここにも適用する。
 *
 * 探索順（`01-architecture.md` 5 章）:
 *   ① PATH（絶対パス要素のみ）— **今までシェルが選んでいたものと同じ** ssh になる。
 *      既存環境の認証が黙って変わらないよう、ここを最優先にする
 *   ② `%SystemRoot%\System32\OpenSSH\ssh.exe` — Windows の ssh-agent サービスと組む
 *   ③ Git 同梱の `<install>/usr/bin/ssh.exe`
 *
 * 見つからなければ null。呼び出し側は**何も注入しない**（git の既定に任せる）。
 */
export async function locateSsh(deps: SshLocatorDeps): Promise<string | null> {
  const exists = deps.exists ?? defaultExists;

  const fromPath = await findOnPath(SSH_NAMES, deps.env, exists);
  if (fromPath !== null) return fromPath;

  if (process.platform === 'win32') {
    const windowsOpenSsh = join(systemRoot(deps.env), 'System32', 'OpenSSH', 'ssh.exe');
    if (await exists(windowsOpenSsh)) return windowsOpenSsh;
  }

  const bundled = bundledSshFor(deps.gitPath);
  if (bundled !== null && (await exists(bundled))) return bundled;

  return null;
}

/**
 * git.exe のパスから Git for Windows 同梱の ssh を導く。
 * git は `<install>/cmd/git.exe` か `<install>/bin/git.exe` に入り、
 * ssh はその 1 つ上（インストール直下）の `usr/bin/ssh.exe` にある。
 * terminalLocator の gitBashFor と同じ導き方。
 */
function bundledSshFor(gitPath: string | null): string | null {
  if (gitPath === null || gitPath.length === 0) return null;
  const installDir = dirname(dirname(gitPath));
  if (installDir.length === 0) return null;
  return join(installDir, 'usr', 'bin', 'ssh.exe');
}
