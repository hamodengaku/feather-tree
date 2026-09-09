import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const NUL = String.fromCharCode(0x00);

/**
 * 複数パスを git に渡すための一時ファイルを作り、処理後に必ず削除する。
 *
 * Windows のコマンドライン長制限（約 32767 文字）と引用符事故を根本的に避けるため、
 * 複数パスの操作は必ず `--pathspec-from-file` + `--pathspec-file-nul` を使う
 * （docs/02-git-command-map.md パス渡しの規則）。
 *
 * @param tempDir 一時ファイルの置き場。呼び出し側が注入する（os.tmpdir() を直接使わない）。
 */
export async function withPathspecFile<T>(
  tempDir: string,
  paths: readonly string[],
  fn: (pathspecFile: string) => Promise<T>,
): Promise<T> {
  await mkdir(tempDir, { recursive: true });
  const file = join(tempDir, `pathspec-${randomBytes(8).toString('hex')}.txt`);

  // UTF-8・BOM なし・NUL 区切り
  await writeFile(file, paths.join(NUL) + NUL, { encoding: 'utf8' });

  try {
    return await fn(file);
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

/** コミットメッセージ等を一時ファイル経由で渡す（改行と日本語を安全に扱うため）。 */
export async function withMessageFile<T>(
  tempDir: string,
  message: string,
  fn: (messageFile: string) => Promise<T>,
): Promise<T> {
  await mkdir(tempDir, { recursive: true });
  const file = join(tempDir, `message-${randomBytes(8).toString('hex')}.txt`);

  // 改行は LF のまま渡す（git 側が処理する）
  await writeFile(file, message.replace(/\r\n/g, '\n'), { encoding: 'utf8' });

  try {
    return await fn(file);
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}
