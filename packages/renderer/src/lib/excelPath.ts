/*
 * Excel 差分モード（決定 33）の対象ファイルの判定。**純関数だけ。**
 *
 * core（`session/excelFiles.ts`）と同じ一覧を持つ。renderer は core を import できない
 * （`.dependency-cruiser.cjs` の `renderer-only-ipc-and-base-ui`）ので 2 か所にあるが、
 * どちらのテストも同じ値を固定しているので、片方だけ変えるとテストが落ちる。
 */

/** Excel 差分モードで中身を開ける拡張子。CSV も含む（2026-10-02）。 */
export const EXCEL_OPENABLE_EXTENSIONS = ['.xlsx', '.xlsm', '.xltx', '.xltm', '.csv'] as const;
/** そのうちブック（ZIP）。差分モードで行単位の比較に置き換えるのはこちらだけ。 */
export const EXCEL_WORKBOOK_EXTENSIONS = ['.xlsx', '.xlsm', '.xltx', '.xltm'] as const;

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function matches(path: string, extensions: readonly string[]): boolean {
  if (baseName(path).startsWith('~$')) return false;
  const lower = path.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

/** Excel 差分モードで開けるファイルか（差分モードでは「Excel モードで開く」を添える）。 */
export function isOpenableExcelPath(path: string): boolean {
  return matches(path, EXCEL_OPENABLE_EXTENSIONS);
}

/**
 * 差分モードで通常の diff の代わりに行単位の比較を出すファイルか（ブックだけ）。
 *
 * **CSV は含めない。** CSV はテキストなので通常の diff が読め、hunk / 行のステージもできる。
 * 置き換えるとそれを失う。Excel の見た目で見たいときは「Excel モードで開く」から。
 */
export function isRowDiffPath(path: string): boolean {
  return matches(path, EXCEL_WORKBOOK_EXTENSIONS);
}
