import { access } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

/**
 * 「ターミナルで開く」の起動先を決める（決定 26）。
 *
 * 開発者が直に git を叩くための逃げ道なので、**git が通るターミナルを開くこと**が要件。
 * ただ Windows ターミナルを出せばいいわけではない。
 */
export interface TerminalLaunch {
  /**
   * 起動する実行ファイル。**必ず絶対パス。**
   *
   * bare な実行ファイル名（`wt.exe` 等）を spawn すると、Windows の libuv は
   * `shell: false` かつ cwd 指定つきのとき、cwd を PATH より先に検索する
   * （`search_path()` の仕様）。cwd はこれから開くリポジトリのルート＝信頼できない場所なので、
   * 同名の実行ファイルを直下に置かれるだけで乗っ取られる（1-A の Critical）。
   * それを避けるため、ここで返す `exe` は常に解決済みの絶対パスにする。
   */
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

  if ((await findOnPath('git.exe', deps.env, exists)) !== null) {
    // wt.exe は PATH 上で見つかった絶対パスを使う（bare 名は返さない）。
    // -d はディレクトリ指定。新しいタブがリポジトリ直下で開く。
    const wt = await findOnPath('wt.exe', deps.env, exists);
    if (wt !== null) return { exe: wt, args: ['-d', deps.cwd] };

    // powershell.exe は PATH 探索に頼らず、%SystemRoot%\System32\...\v1.0 を直接組み立てる。
    // System32 は cwd 検索より前に来ないため元々安全だが、絶対パスで統一して事故の芽を消す。
    // cwd は spawn 側で与えるので引数は要らない。
    const powershell = powershellPath(deps.env);
    if (await exists(powershell)) return { exe: powershell, args: [] };
  }

  const gitBash = gitBashFor(deps.gitPath);
  if (gitBash !== null && (await exists(gitBash))) return { exe: gitBash, args: [] };

  return null;
}

/** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` の絶対パスを組み立てる。 */
function powershellPath(env: NodeJS.ProcessEnv): string {
  const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
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

/**
 * PATH 上で name を探し、見つかった**絶対パス**を返す（bare 名は返さない）。
 *
 * 相対パス要素（`.` を含む）・空要素は無視する。PATH に `.` が混ざっていると
 * 「カレントディレクトリの同名ファイルが拾われる」という 1-A と同種の問題になるため、
 * 絶対パスでない PATH エントリはそもそも候補にしない。
 */
async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  const rawPath = env['PATH'] ?? env['Path'] ?? '';
  if (rawPath.length === 0) return null;

  const separator = process.platform === 'win32' ? ';' : ':';
  for (const dir of rawPath.split(separator)) {
    const trimmed = dir.trim().replace(/^"|"$/g, '');
    if (trimmed.length === 0) continue;
    if (!isAbsolute(trimmed)) continue;
    const candidate = join(trimmed, name);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
