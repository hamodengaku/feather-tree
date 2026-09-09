import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

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

  if (deps.configuredPath !== undefined && deps.configuredPath.length > 0) {
    if (await exists(deps.configuredPath)) {
      return { gitPath: deps.configuredPath, source: 'configured' };
    }
  }

  const fromPath = await searchPath(deps.env, exists);
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

async function searchPath(env: NodeJS.ProcessEnv, exists: (p: string) => Promise<boolean>): Promise<string | null> {
  const rawPath = env['PATH'] ?? env['Path'] ?? '';
  if (rawPath.length === 0) return null;

  const separator = process.platform === 'win32' ? ';' : ':';
  const names = process.platform === 'win32' ? ['git.exe'] : ['git'];

  for (const dir of rawPath.split(separator)) {
    const trimmed = dir.trim().replace(/^"|"$/g, '');
    if (trimmed.length === 0) continue;
    for (const name of names) {
      const candidate = join(trimmed, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

/** HKLM\SOFTWARE\GitForWindows の InstallPath を読む。reg query を 1 回だけ実行する。 */
function queryGitForWindowsRegistry(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);

  return new Promise((resolve) => {
    const child = spawn('reg', ['query', 'HKLM' + String.fromCharCode(92) + 'SOFTWARE' + String.fromCharCode(92) + 'GitForWindows', '/v', 'InstallPath'], {
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

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
