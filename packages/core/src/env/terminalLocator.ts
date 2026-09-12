import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * 「ターミナルで開く」の起動先を決める（決定 26）。
 *
 * 開発者が直に git を叩くための逃げ道なので、**git が通るターミナルを開くこと**が要件。
 * ただ Windows ターミナルを出せばいいわけではない。
 */
export interface TerminalLaunch {
  /** 起動する実行ファイル。PATH 上の名前か絶対パス。 */
  readonly exe: string;
  /** 引数。必ず配列で持つ（コマンド文字列を組み立てない）。 */
  readonly args: readonly string[];
}

export interface TerminalLocatorDeps {
  readonly env: NodeJS.ProcessEnv;
  /** 開く対象のリポジトリルート（絶対パス）。 */
  readonly cwd: string;
  /** 見つかっている git.exe。null なら git そのものが無い。 */
  readonly gitPath: string | null;
  /** テストから差し替えられるようにしておく。 */
  readonly exists?: (path: string) => Promise<boolean>;
}

/**
 * 開くべきターミナルを決める。git を実行できる見込みが無ければ null。
 *
 *   ① git が PATH にある → wt.exe → 無ければ powershell.exe
 *   ② git が PATH に無い → Git Bash（そこでしか git が通らない）
 *   ③ Git Bash も無い    → null（呼び出し側がエラーを出す）
 *
 * ① を locateGit で判定しないのは、あれが PATH に無いときレジストリ照会（reg の起動）へ進むため。
 * ここが欲しいのは「PATH に居るか」の一点だけなので、PATH を見るだけで済ませる。
 */
export async function locateTerminal(deps: TerminalLocatorDeps): Promise<TerminalLaunch | null> {
  const exists = deps.exists ?? defaultExists;

  if (await findOnPath('git.exe', deps.env, exists)) {
    // -d はディレクトリ指定。新しいタブがリポジトリ直下で開く。
    if (await findOnPath('wt.exe', deps.env, exists)) return { exe: 'wt.exe', args: ['-d', deps.cwd] };
    // powershell.exe は Windows に必ずある。cwd は spawn 側で与えるので引数は要らない。
    return { exe: 'powershell.exe', args: [] };
  }

  const gitBash = gitBashFor(deps.gitPath);
  if (gitBash !== null && (await exists(gitBash))) return { exe: gitBash, args: [] };

  return null;
}

/**
 * git.exe のパスから git-bash.exe を導く。
 * Git for Windows は `<install>/cmd/git.exe` か `<install>/bin/git.exe` に入り、
 * git-bash.exe はその 1 つ上（インストール直下）にある。
 */
function gitBashFor(gitPath: string | null): string | null {
  if (gitPath === null) return null;
  const installDir = dirname(dirname(gitPath));
  if (installDir.length === 0) return null;
  return join(installDir, 'git-bash.exe');
}

async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => Promise<boolean>,
): Promise<boolean> {
  const rawPath = env['PATH'] ?? env['Path'] ?? '';
  if (rawPath.length === 0) return false;

  const separator = process.platform === 'win32' ? ';' : ':';
  for (const dir of rawPath.split(separator)) {
    const trimmed = dir.trim().replace(/^"|"$/g, '');
    if (trimmed.length === 0) continue;
    if (await exists(join(trimmed, name))) return true;
  }
  return false;
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
