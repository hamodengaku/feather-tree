/*
 * 表の 1 行 → git の hunk / 行の座標（決定 32 / 設計 A-3）。**この機能の心臓部。**
 *
 * `buildHunkPatch`（git 層）は「hunk の添字 + その hunk の中の行の添字」で選択を受け取る。
 * 一方こちらが持っているのは「ファイルの何行目か」なので、diff から索引を 1 回作って引く。
 *
 *   removedAt: 旧側の行番号 -> {hunk, line}   … kind === 'removed' の行だけ
 *   addedAt  : 新側の行番号 -> {hunk, line}   … kind === 'added'   の行だけ
 *
 * 文脈行は索引に入れない。選ぶ必要が無いし、選んでもいけない——
 * `buildHunkPatch` は「選ばれなかった変更行を pre-image に居るなら文脈へ落とす」ので、
 * 文脈行はこちらが指定しなくても常に正しく出力される。
 *
 * **git 層の型を import しない。** 構造的に代入できる最小のインタフェースを
 * ここで宣言して受け取ることで、unity 層が git を知らないままでいられる
 * （`.dependency-cruiser.cjs` の `no-upward-from-unity`）。
 */

import type { PropertyRow } from '../props/rows.js';
import { type LineView, lineEnd, lineStart } from '../parse/lexer.js';

/* ------------------------------------------------------------------ 受け取る形（構造的） */

export interface DiffLineLike {
  /** `'context' | 'added' | 'removed' | 'no-newline'`。 */
  readonly kind: string;
  readonly text: string;
  readonly oldLineNo: number | null;
  readonly newLineNo: number | null;
}

export interface DiffHunkLike {
  readonly header: string;
  readonly lines: readonly DiffLineLike[];
}

export interface FileDiffLike {
  readonly hunks: readonly DiffHunkLike[];
}

/* ------------------------------------------------------------------ 返す形 */

/** `HunkSelectionDto` にそのまま渡せる形。`header` と `lineCount` はズレ検出の指紋。 */
export interface HunkPick {
  readonly index: number;
  readonly header: string;
  readonly lineCount: number;
  readonly lines: readonly number[];
}

interface Spot {
  readonly hunk: number;
  readonly line: number;
}

export interface LineIndex {
  readonly removedAt: ReadonlyMap<number, Spot>;
  readonly addedAt: ReadonlyMap<number, Spot>;
  readonly hunks: readonly { readonly header: string; readonly lineCount: number; readonly allowsLines: boolean }[];
}

/**
 * diff から索引を 1 回だけ作る。
 *
 * **必ず「apply が読み直すのと同じ条件で取った diff」を渡すこと**（core の
 * `getDiffForPatch`）。表示用の diff は行数上限が違うので、hunk の添字がずれる（A-3）。
 */
export function buildLineIndex(diff: FileDiffLike): LineIndex {
  const removedAt = new Map<number, Spot>();
  const addedAt = new Map<number, Spot>();
  const hunks: { header: string; lineCount: number; allowsLines: boolean }[] = [];

  diff.hunks.forEach((hunk, h) => {
    let allowsLines = true;
    hunk.lines.forEach((line, i) => {
      if (line.kind === 'no-newline') {
        // 末尾改行なしマーカーを含む hunk は行単位で選び分けられない
        // （git 層の hunkAllowsLineSelection と同じ判断にする）
        allowsLines = false;
        return;
      }
      if (line.kind === 'removed' && line.oldLineNo !== null) {
        removedAt.set(line.oldLineNo, { hunk: h, line: i });
      } else if (line.kind === 'added' && line.newLineNo !== null) {
        addedAt.set(line.newLineNo, { hunk: h, line: i });
      }
    });
    hunks.push({ header: hunk.header, lineCount: hunk.lines.length, allowsLines });
  });

  return { removedAt, addedAt, hunks };
}

/**
 * 行番号の組から選択を作る。**引けなければ null**（＝ステージのボタンを出さない）。
 *
 * null になるのは次のどちらか。どちらも「押せるのに main が拒否する」を避けるための判断で、
 * UI の出し分けと apply 前のガードが同じ関数を使う（A-4）。
 *   1. 変更行が 1 つも無い（未変更のプロパティ）
 *   2. 選択が「末尾改行なしマーカーを含む hunk」にかかっている
 */
export function selectionForLines(
  index: LineIndex,
  oldLines: readonly number[],
  newLines: readonly number[],
): readonly HunkPick[] | null {
  const picks = new Map<number, Set<number>>();

  const add = (spot: Spot | undefined): void => {
    if (spot === undefined) return;
    let set = picks.get(spot.hunk);
    if (set === undefined) {
      set = new Set<number>();
      picks.set(spot.hunk, set);
    }
    set.add(spot.line);
  };

  for (const n of oldLines) add(index.removedAt.get(n));
  for (const n of newLines) add(index.addedAt.get(n));

  if (picks.size === 0) return null;

  const out: HunkPick[] = [];
  for (const [hunkIndex, lines] of [...picks.entries()].sort((a, b) => a[0] - b[0])) {
    const hunk = index.hunks[hunkIndex];
    if (hunk === undefined) return null;
    if (!hunk.allowsLines) return null;
    out.push({
      index: hunkIndex,
      header: hunk.header,
      lineCount: hunk.lineCount,
      lines: [...lines].sort((a, b) => a - b),
    });
  }
  return out;
}

/**
 * 表の 1 行ぶん（「1 パラメータだけステージ」）。
 *
 * **値が変わっていない行は常に null。** フロー（`{x: 2.5, y: 1, z: 1}`）では
 * 変わっていない `y` も変わった `x` と同じ行に乗るので、行番号だけで見ると
 * 「変わっていないのに引き当てられる」ことになる。要件 13 の
 * 「未変更行にはステージボタンを出さない」をここで保証して、
 * UI の出し分けと main の判断が 1 か所で決まるようにする（A-4）。
 */
export function selectionForRow(index: LineIndex, row: PropertyRow): readonly HunkPick[] | null {
  if (row.state === 'same') return null;
  return selectionForLines(index, row.oldLines, row.newLines);
}

/**
 * その 1 行をステージすると、**一緒に入ってしまう他の変更行**。
 *
 * git が扱えるのは行までなので、`{x: 2.5, y: 3, z: 1}` の `x` と `y` が両方
 * 変わっていたら、片方だけを index に入れることはできない。
 * 黙って 2 つ入れると「1 パラメータだけ」の名に反するので、
 * ボタンの説明に添えて**押す前に分かる**ようにする（要件 13 の限界の明示）。
 */
export function companionRows(
  index: LineIndex,
  rows: readonly PropertyRow[],
  row: PropertyRow,
): readonly PropertyRow[] {
  const picks = selectionForRow(index, row);
  if (picks === null) return [];

  const spots = new Set<string>();
  for (const pick of picks) {
    for (const line of pick.lines) spots.add(String(pick.index) + ':' + String(line));
  }

  const out: PropertyRow[] = [];
  for (const other of rows) {
    if (other === row || other.state === 'same') continue;
    const otherPicks = selectionForRow(index, other);
    if (otherPicks === null) continue;
    const overlaps = otherPicks.some((pick) =>
      pick.lines.some((line) => spots.has(String(pick.index) + ':' + String(line))),
    );
    if (overlaps) out.push(other);
  }
  return out;
}

/**
 * ノード 1 つぶん（「コンポーネントをステージ」）。
 *
 * **そのノードの表に出ている全行の和集合**がそのまま定義。
 * 要件 13 の「GameObject を選んでも配下コンポーネントは含めない」は、
 * 表に配下コンポーネントの行が出ていないことで自動的に満たされる。
 *
 * `selectionForRow` と違って**未変更の行も含めて数える**。こちらは
 * 「このノードで変わったものを全部」なので、どの行にも現れない変更
 * （空白だけの差など）を取りこぼさないほうが意図に合う。
 * 変わっていない行は索引に載らないので、結果には影響しない。
 */
export function selectionForRows(
  index: LineIndex,
  rows: readonly PropertyRow[],
): readonly HunkPick[] | null {
  const oldLines: number[] = [];
  const newLines: number[] = [];
  for (const row of rows) {
    oldLines.push(...row.oldLines);
    newLines.push(...row.newLines);
  }
  return selectionForLines(index, oldLines, newLines);
}

/* ------------------------------------------------------------------ 全文と diff の照合 */

export type Side = 'old' | 'new';

/**
 * 取得した全文と diff が同じものを指しているか（決定 32 / A-2）。
 *
 * `git show` が返すのは smudge フィルタも改行変換も通していない生の blob なので、
 * `core.autocrlf=true` の環境では**自前比較で全行が変更に見えるのに
 * `git diff` は変更なしと言う**という食い違いが起きる。LFS のポインタでも同じ。
 * ここで気づかずにステージを許すと、**押した行とは別の場所が index に入る**。
 *
 * 行末の CR は落として比べる（比較用に落とすだけで、行番号は落とさない）。
 */
export function verifyAlignment(file: LineView, diff: FileDiffLike, side: Side): boolean {
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'no-newline') continue;
      const lineNo = side === 'old' ? line.oldLineNo : line.newLineNo;
      if (lineNo === null) continue;
      if (lineNo < 1 || lineNo > file.lineCount) return false;
      if (!lineMatches(file, lineNo, line.text)) return false;
    }
  }
  return true;
}

/** 文字列を作らずに 1 行ぶん突き合わせる（diff の行数だけ呼ばれるので安くしておく）。 */
function lineMatches(file: LineView, lineNo: number, text: string): boolean {
  const start = lineStart(file, lineNo);
  const end = lineEnd(file, lineNo);
  let stop = text.length;
  // diff の行テキスト側にも CR が残っていることがある
  if (stop > 0 && text.charCodeAt(stop - 1) === 13) stop -= 1;
  if (end - start !== stop) return false;
  for (let i = 0; i < stop; i += 1) {
    if (file.text.charCodeAt(start + i) !== text.charCodeAt(i)) return false;
  }
  return true;
}
