/**
 * リポジトリタブのラベル（決定 24）に出す文字列の整形。
 *
 * 純関数として切り出してあるのは、境界の扱い（サロゲートペア・スラッシュだけの名前・
 * ちょうど上限の長さ）が目で見て確かめにくく、テストで固定しておきたいため。
 */

/** タブに出す件名の文字数。これを超えた分は … にする。 */
export const TAB_SUBJECT_CHARS = 10;

/**
 * ブランチ名のうち、タブの丸に出す部分。**スラッシュの最終セグメントだけ**。
 *
 * `hamodengaku/test/test` → `test`。フォルダ付きの名前でタブが伸びすぎるのを防ぐ
 * （タブ段は横スクロールするので、伸びた分だけ他のタブが画面外へ出ていく）。
 * 完全な名前はタブの title で読める。
 */
export function branchLeaf(shortName: string): string {
  const segments = shortName.split('/').filter((s) => s.length > 0);
  return segments.at(-1) ?? shortName;
}

/**
 * 件名を指定文字数で打ち切り、超えていたら … を付ける。
 *
 * 数えるのは **コードポイント**（`Array.from`）。`String.length` は UTF-16 の単位数なので、
 * 絵文字（gitmoji など）がサロゲートペアの途中で切れて壊れた字になる。
 *
 * 打ち切りは表示だけの話で、全文はタブの title で読める。
 */
export function truncateSubject(subject: string, max: number = TAB_SUBJECT_CHARS): string {
  const chars = Array.from(subject);
  if (chars.length <= max) return subject;
  return chars.slice(0, max).join('') + '…';
}
