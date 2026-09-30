/*
 * Excel 差分モード（決定 33）の対象ファイルの判定。**純関数だけ。**
 *
 * core（`session/excelFiles.ts`）と同じ一覧を持つ。renderer は core を import できない
 * （`.dependency-cruiser.cjs` の `renderer-only-ipc-and-base-ui`）ので 2 か所にあるが、
 * どちらのテストも同じ値を固定しているので、片方だけ変えるとテストが落ちる。
 */

/** Excel 差分モードで中身を開ける拡張子。 */
export const EXCEL_OPENABLE_EXTENSIONS = ['.xlsx', '.xlsm', '.xltx', '.xltm'] as const;

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** 差分モードで行単位の比較を出し、「Excel モードで開く」を添えるファイルか。 */
export function isOpenableExcelPath(path: string): boolean {
  if (baseName(path).startsWith('~$')) return false;
  const lower = path.toLowerCase();
  return EXCEL_OPENABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
