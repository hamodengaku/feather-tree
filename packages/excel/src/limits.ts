/*
 * Excel 差分モードの上限（決定 33）。**上限はこの 1 か所でだけ決める。**
 *
 * どれも「超えたら落とさずに案内を出す」ための線で、性能目標（docs/01-architecture.md 12 章）とは別物。
 * ZIP の展開後サイズの上限は、悪意ある ZIP 爆弾（数 KB が数 GB に膨らむ）への備えを兼ねる。
 */

export interface ExcelLimits {
  /** ファイル 1 つ（ZIP のまま）の大きさ。git から読むときもこれで打ち切る。 */
  readonly maxFileBytes: number;
  /** ZIP 要素 1 つの展開後の大きさ。 */
  readonly maxEntryBytes: number;
  /** ブック 1 冊で展開する合計。 */
  readonly maxTotalBytes: number;
  /** 1 シートのセル数。超えたらそのシートは読んだところまでで打ち切る。 */
  readonly maxCellsPerSheet: number;
  /** ブック 1 冊のセル数。超えたら以降のシートは読まない。 */
  readonly maxCellsPerBook: number;
  /** 列数。これより右の列は読まない（Excel の上限は 16,384）。 */
  readonly maxColumns: number;
  /** 1 シートの行要素の数（セルの無い行も数える。Excel の上限は 1,048,576）。 */
  readonly maxRowsPerSheet: number;
  /** 共有文字列の件数。 */
  readonly maxSharedStrings: number;
  /** 画面に送る 1 セルの表示文字の長さ。全文は値バー（getCell）で見せる。 */
  readonly maxCellText: number;
  /** 表示形式の文字列の長さ。これより長いものは「標準」で出す（Excel 自身の上限は 255）。 */
  readonly maxFormatCode: number;
  /** 差分モードの行単位比較で出す行の合計。 */
  readonly maxRowDiffLines: number;
  /** 行単位比較の 1 hunk に出す列の数。 */
  readonly maxRowDiffColumns: number;
  /** 行の対応付け（Myers）の編集距離の予算。 */
  readonly maxAlignEdits: number;
  /** 行の対応付けの計算量の予算（(n+m)·D）。 */
  readonly maxAlignWork: number;
}

export const DEFAULT_LIMITS: ExcelLimits = {
  maxFileBytes: 100 * 1024 * 1024,
  maxEntryBytes: 200 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  maxCellsPerSheet: 1_000_000,
  maxCellsPerBook: 2_000_000,
  maxColumns: 2048,
  maxRowsPerSheet: 1_048_576,
  maxSharedStrings: 2_000_000,
  maxCellText: 2000,
  maxFormatCode: 255,
  maxRowDiffLines: 2000,
  maxRowDiffColumns: 200,
  maxAlignEdits: 2000,
  maxAlignWork: 10_000_000,
};

/**
 * 中止の合図。`AbortSignal` がそのまま渡せるように、構造だけで受ける
 * （このパッケージは Node も DOM の型も前提にしない）。
 */
export interface CancelToken {
  readonly aborted: boolean;
}

export const NEVER_CANCELLED: CancelToken = { aborted: false };
