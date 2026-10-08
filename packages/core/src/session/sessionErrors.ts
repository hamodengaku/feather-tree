/*
 * 採用・適用の直前の照合で使うエラー。
 *
 * operations.ts（hunk・決定 30 の採用）と excelConflict.ts（決定 34 の採用）の両方が投げる。
 * operations.ts に置いたままだと excelConflict.ts → operations.ts → repositorySession.ts → excelConflict.ts の
 * 循環になるので、ここに分けた（operations.ts からも従来どおり export する）。
 */

/**
 * View が表示していた diff が、ディスク上の実際の状態と食い違っている。
 *
 * 決定 14 によりファイル監視もポーリングもしないので、表示中の diff は古くなりうる。
 * 古い行番号のまま apply すると、git が文脈を頼りに**別の場所へ**当ててしまうため、
 * 適用の直前に取り直して照合する。
 */
export class StaleDiffError extends Error {
  constructor(message = '表示中の差分が古くなっています。一覧を更新してからやり直してください。') {
    super(message);
    this.name = 'StaleDiffError';
  }
}

/**
 * 採用できない（マーカーの入れ子・閉じていない・バイナリ。Excel では削除された側・セル単位で採れない・未決定が残る）。
 *
 * 表示側もこの条件ではボタンを出さないので、ここへ来るのは食い違いが起きたときだけ。
 * 中途半端に書き戻すと本文を壊すため、**何も書かずに断る**。
 */
export class ConflictUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictUnsupportedError';
  }
}
