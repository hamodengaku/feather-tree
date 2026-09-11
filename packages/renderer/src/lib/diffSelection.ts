import type { FileDiffDto, HunkSelectionDto } from '@feathertree/ipc';

/**
 * diff ペインから main へ送る「どの hunk / どの行か」の組み立て（対応表 #33 / #34）。
 *
 * ズレ検出用の指紋（header と行数）をここで詰めることで、
 * 「表示していたものと同じか」の判定材料が UI コードに散らばらないようにする。
 */

/**
 * その hunk で行単位の操作を許すか。
 *
 * 末尾改行なしマーカーを含む hunk は、行を選び分けると
 * 「最終行を削除するのに改行有無マーカーが無い」不整合パッチになりうるので、
 * hunk 全体としてのみ扱う（元の hunk をそのまま再生する分には必ず整合する）。
 */
export function hunkAllowsLines(diff: FileDiffDto, hunkIndex: number): boolean {
  const hunk = diff.hunks[hunkIndex];
  if (hunk === undefined) return false;
  return !hunk.lines.some((l) => l.kind === 'no-newline');
}

/** hunk ヘッダのボタン用。その hunk 全体を 1 件だけ指す。 */
export function wholeHunkSelection(
  diff: FileDiffDto,
  hunkIndex: number,
): readonly HunkSelectionDto[] {
  const hunk = diff.hunks[hunkIndex];
  if (hunk === undefined) return [];
  return [{ index: hunkIndex, header: hunk.header, lineCount: hunk.lines.length, lines: null }];
}

/**
 * 行モード中のクリック用。押された 1 行だけを指す。
 *
 * 対になる行（`-古い行` に対する `+新しい行` など）は含めない。
 * 片方だけを index に入れるのは git の行単位ステージとして正しい振る舞いで、
 * たとえば「新しい行を足すが古い行はまだ残す」という中間状態を作れる。
 */
export function singleLineSelection(
  diff: FileDiffDto,
  hunkIndex: number,
  lineIndex: number,
): readonly HunkSelectionDto[] {
  const hunk = diff.hunks[hunkIndex];
  if (hunk === undefined) return [];
  const line = hunk.lines[lineIndex];
  if (line === undefined || (line.kind !== 'added' && line.kind !== 'removed')) return [];
  return [
    { index: hunkIndex, header: hunk.header, lineCount: hunk.lines.length, lines: [lineIndex] },
  ];
}
