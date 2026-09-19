import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

export type GitSource = 'configured' | 'path' | 'registry';

/**
 * `reg query` を待つ上限（ms）。
 *
 * ここは起動処理の中で唯一「外部プロセスの応答を無条件に待つ」箇所だった。
 * `reg.exe` が返らなければ `locateGit()` も返らず、**起動が永久に止まる**
 * （docs/01-architecture.md 11 章 2026-09-19 追加分）。レジストリの 1 値を読むだけなので
 * 数秒で足り、超えたら「見つからなかった」として先へ進む（導入案内が出るだけで済む）。
 */
export const REGISTRY_QUERY_TIMEOUT_MS = 3_000;

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
  /** レジストリ探索を待つ上限（ms）。既定は REGISTRY_QUERY_TIMEOUT_MS。テストから縮める。 */
  readonly registryTimeoutMs?: number;
}

/**
 * 返らないかもしれない処理に上限を与える。
 *
 * 打ち切っても `promise` 自体は走り続けるので、**呼び出し側が別途 kill する**こと
 * （`queryGitForWindowsRegistry` は自前でも kill する。ここは注入された実装も含めて
 * 「起動が止まらない」ことだけを保証する最後の網）。
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

  if (deps.configuredPath !== undefined && deps.configuredPath.length > 0) {
    if (await exists(deps.configuredPath)) {
      return { gitPath: deps.configuredPath, source: 'configured' };
    }
  }

  const fromPath = await searchPath(deps.env, exists);
  if (fromPath !== null) return { gitPath: fromPath, source: 'path' };

  /*
   * ここだけが外部プロセスの応答を待つ。返らなければ起動そのものが止まるので、
   * 必ず上限を与える（docs/01-architecture.md 11 章 2026-09-19 追加分）。
   * 打ち切ったときは「レジストリにも無かった」として扱い、導入案内へ落とす。
   */
  const timeoutMs = deps.registryTimeoutMs ?? REGISTRY_QUERY_TIMEOUT_MS;
  const queryRegistry = deps.queryRegistry ?? ((): Promise<string | null> => queryGitForWindowsRegistry(timeoutMs));
  const installPath = await withTimeout(queryRegistry(), timeoutMs, null);
  if (installPath !== null) {
    for (const candidate of [join(installPath, 'cmd', 'git.exe'), join(installPath, 'bin', 'git.exe')]) {
      if (await exists(candidate)) return { gitPath: candidate, source: 'registry' };
    }
  }

  return null;
}

async function searchPath(env: NodeJS.ProcessEnv, exists: (p: string) => Promise<boolean>): Promise<string | null> {
  const rawPath = env['PATH'] ?? env['Path'] ?? '';
  if (rawPath.length === 0) return null;

  const separator = process.platform === 'win32' ? ';' : ':';
  const names = process.platform === 'win32' ? ['git.exe'] : ['git'];

  for (const dir of rawPath.split(separator)) {
    const trimmed = dir.trim().replace(/^"|"$/g, '');
    // 相対パス要素（`.` を含む）は無視する。ここは cwd を渡さない spawn なので実害は無いが、
    // terminalLocator.ts の findOnPath と同じ規則にしておく（1-A の教訓）。
    if (trimmed.length === 0 || !isAbsolute(trimmed)) continue;
    for (const name of names) {
      const candidate = join(trimmed, name);
      if (await exists(candidate)) return candidate;
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
function queryGitForWindowsRegistry(timeoutMs: number = REGISTRY_QUERY_TIMEOUT_MS): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);

  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
  const regPath = join(systemRoot, 'System32', 'reg.exe');

  return new Promise((resolve) => {
    const child = spawn(regPath, ['query', 'HKLM' + String.fromCharCode(92) + 'SOFTWARE' + String.fromCharCode(92) + 'GitForWindows', '/v', 'InstallPath'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    /*
     * 決着は 1 回だけ。タイムアウトと close / error が競っても、
     * 先に来たほうで確定させてタイマーを片付ける（残すとプロセスが終わらない）。
     */
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      /*
       * 返らない reg.exe を待ち続けない。kill して「見つからなかった」で先へ進む。
       * `reg query` は孫を持たないので kill だけで足りる（git 層の killTree は要らない）。
       */
      try {
        child.kill();
      } catch {
        // 既に終わっていれば何もしなくてよい
      }
      finish(null);
    }, timeoutMs);
    // 探索のタイマーでアプリの終了を引き止めない
    timer.unref?.();

    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', () => finish(null));
    child.on('close', () => {
      const m = /InstallPath\s+REG_SZ\s+(.+)/.exec(out);
      const value = m?.[1]?.trim();
      finish(value !== undefined && value.length > 0 ? value : null);
    });
  });
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
