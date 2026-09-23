/*
 * guid からスクリプト名 / Prefab 名を引く索引（決定 32 / 要件 11）。
 *
 * Prefab の中には `m_Script: {guid: ...}` しか書かれていない。名前は別の
 * `<ファイル名>.meta` にしかないので、引きたければリポジトリを走査するしかない。
 *
 * **git は 1 プロセスも起動しない。** `ls-files` も `grep` も使わず Node で読む
 * （docs/02-git-command-map.md「git は 0 プロセス」）。
 *
 * **利用者が明示的にボタンを押したときだけ走る。** 巨大プロジェクトでは数千の
 * `.meta` を読むことになり、この環境はファイル I/O が極端に遅い（CLAUDE.md）。
 * ファイルを選ぶたびに自動で走らせてよい処理ではない。
 */

import { readdir, open } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 走査から外すディレクトリ。
 *
 * どれも Unity や IDE の生成物で、**guid の出どころではない**
 * （`Library/` には同じ guid の写しが大量に入っていて、読むだけ無駄になる）。
 */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  'library',
  'temp',
  'logs',
  'obj',
  'bin',
  'build',
  'builds',
  'usersettings',
  'memorycaptures',
  'recordings',
  '.git',
  'node_modules',
]);

/**
 * 索引に載せる拡張子（`.meta` を除いた本体側）。
 *
 * `.cs` はスクリプト名（要件 11）、`.prefab` は PrefabInstance の元 Prefab 名。
 * ここを増やすと走査が重くなるだけなので、名前を出す当てがあるものに絞る。
 */
const INDEXED_EXTENSIONS = ['.cs', '.prefab'] as const;

/** guid は 32 桁の 16 進。`.meta` の先頭付近にある。 */
const GUID_LENGTH = 32;
/** `.meta` の先頭だけ読む。guid は 2 行目に来るので、これで十分足りる。 */
const META_HEAD_BYTES = 256;

/** 走査の上限。壊れたシンボリックリンクなどで無限に潜らないための保険。 */
const MAX_DEPTH = 24;

export interface ScriptIndex {
  /** guid -> 画面に出す名前。 */
  readonly names: ReadonlyMap<string, string>;
  /** 読んだ `.meta` の数（画面に「N 件解決しました」と出すため）。 */
  readonly scanned: number;
}

export const EMPTY_SCRIPT_INDEX: ScriptIndex = { names: new Map(), scanned: 0 };

/**
 * リポジトリを走査して索引を作る。
 *
 * 見つからない・読めない `.meta` は黙って飛ばす。ここで失敗すると
 * 「名前が出ない」ではなく「ボタンがエラーになる」になってしまい、割に合わない。
 */
export async function buildScriptIndex(root: string, signal?: AbortSignal): Promise<ScriptIndex> {
  const names = new Map<string, string>();
  let scanned = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    signal?.throwIfAborted();

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // 読めないディレクトリ（権限・切断されたドライブ）は飛ばす
      return;
    }

    for (const dirent of entries) {
      signal?.throwIfAborted();
      const full = join(dir, dirent.name);

      if (dirent.isDirectory()) {
        if (SKIP_DIRECTORIES.has(dirent.name.toLowerCase())) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!dirent.isFile()) continue;

      const display = displayNameFor(dirent.name);
      if (display === null) continue;

      const guid = await readGuid(full, signal);
      if (guid === null) continue;
      scanned += 1;
      // 同じ guid が 2 度出ることは無いが、出たら先に見つけたほうを残す
      if (!names.has(guid)) names.set(guid, display);
    }
  };

  await walk(root, 0);
  return { names, scanned };
}

/**
 * その `.meta` を索引に載せるか。載せるなら画面に出す名前を返す。
 *
 * `.cs.meta` は拡張子を落として型名そのものにする（`WeaponController`）。
 * `.prefab.meta` は落とさない（`Actor.prefab`。ヒエラルキーで
 * 「どの Prefab の実体か」を読むので、拡張子があったほうが分かる）。
 */
function displayNameFor(fileName: string): string | null {
  if (!fileName.endsWith('.meta')) return null;
  const base = fileName.slice(0, -'.meta'.length);
  const lower = base.toLowerCase();
  for (const ext of INDEXED_EXTENSIONS) {
    if (!lower.endsWith(ext)) continue;
    return ext === '.cs' ? base.slice(0, -ext.length) : base;
  }
  return null;
}

/** `.meta` の先頭だけ読んで guid を取り出す。無ければ null。 */
async function readGuid(path: string, signal?: AbortSignal): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(META_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, META_HEAD_BYTES, 0);
    signal?.throwIfAborted();
    return extractGuid(buffer.toString('utf8', 0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** `guid: <32 桁の 16 進>` を探す。行頭の空白は許す（他ツールが整形した場合に備える）。 */
export function extractGuid(head: string): string | null {
  for (const line of head.split(String.fromCharCode(10))) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('guid:')) continue;
    const value = trimmed.slice('guid:'.length).trim();
    if (value.length !== GUID_LENGTH) return null;
    for (let i = 0; i < value.length; i += 1) {
      const c = value.charCodeAt(i);
      const hex =
        (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
      if (!hex) return null;
    }
    return value.toLowerCase();
  }
  return null;
}
