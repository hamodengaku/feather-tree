import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/**
 * PATH から実行ファイルを探す、唯一の場所。
 *
 * **返すのは必ず絶対パス。bare 名は返さない。**
 * bare な実行ファイル名を spawn すると Windows の libuv は cwd（git の場合は
 * リポジトリルート）を PATH より先に検索するため、悪意あるリポジトリが置いた
 * 同名の実行ファイルを拾いうる（脆弱性診断 1-A）。同じ理由で、**PATH の要素に
 * 相対パス（`.` など）が混ざっていたらその要素ごと無視する。**
 *
 * GitLocator / TerminalLocator / SshLocator が同じ規則を使うよう、
 * ここ 1 箇所に集約してある（3 箇所に散っていると片方だけ直し忘れる）。
 */
export async function findOnPath(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  exists: (path: string) => Promise<boolean> = defaultExists,
): Promise<string | null> {
  const rawPath = env['PATH'] ?? env['Path'] ?? '';
  if (rawPath.length === 0) return null;

  const separator = process.platform === 'win32' ? ';' : ':';
  for (const dir of rawPath.split(separator)) {
    // Windows の PATH は要素が引用符で囲まれていることがある
    const trimmed = dir.trim().replace(/^"|"$/g, '');
    if (trimmed.length === 0 || !isAbsolute(trimmed)) continue;
    for (const name of names) {
      const candidate = join(trimmed, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

/** `%SystemRoot%` を解決する。環境変数が無い場合だけ `C:\Windows` に落とす。 */
export function systemRoot(env: NodeJS.ProcessEnv): string {
  return env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows';
}

export async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
