/*
 * Excel 差分モードのファイル一覧（決定 33）。**git は 0 プロセス**——status のスナップショットを
 * 拡張子で絞るだけ。
 *
 * porcelain v2 は 1 パスにつき 1 レコード（ステージ側と作業ツリー側の両方の印を持つ）なので、
 * 「ステージ済み・未ステージ・未追跡の和集合」はスナップショットそのものから無視を除けば足りる。
 *
 * Excel がブックを開いている間に作る `~$` で始まるロックファイルは出さない
 * （開くたびに未追跡として一覧に現れ、選んでも中身は読めない）。
 */

import { EXCEL_LISTED_ONLY_EXTENSIONS, EXCEL_OPENABLE_EXTENSIONS } from '@feathertree/excel';
import type { FileEntry, StatusSnapshot } from '@feathertree/git';

/** 一覧に出す上限。これを超えるリポジトリでは打ち切って印を立てる。 */
export const MAX_EXCEL_FILES = 5000;

export interface ExcelFileEntry {
  readonly entry: FileEntry;
  /** Excel 差分モードで中身を開けるか（`.xls` / `.xlsb` は false）。 */
  readonly openable: boolean;
}

export interface ExcelFileList {
  readonly entries: readonly ExcelFileEntry[];
  readonly truncated: boolean;
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

function endsWithAny(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

/** Excel 差分モードが開けるファイルか。 */
export function isOpenableExcelPath(path: string): boolean {
  return endsWithAny(path, EXCEL_OPENABLE_EXTENSIONS);
}

/** Excel のファイル（開けないものを含む）か。ロックファイルは除く。 */
export function isExcelPath(path: string): boolean {
  if (baseName(path).startsWith('~$')) return false;
  return endsWithAny(path, EXCEL_OPENABLE_EXTENSIONS) || endsWithAny(path, EXCEL_LISTED_ONLY_EXTENSIONS);
}

export function listExcelFiles(snapshot: StatusSnapshot | null): ExcelFileList {
  if (snapshot === null) return { entries: [], truncated: false };
  const found = snapshot.entries
    .filter((e) => e.kind !== 'ignored' && isExcelPath(e.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    entries: found.slice(0, MAX_EXCEL_FILES).map((entry) => ({ entry, openable: isOpenableExcelPath(entry.path) })),
    truncated: found.length > MAX_EXCEL_FILES,
  };
}
