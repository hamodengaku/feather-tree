/*
 * Unity の YAML を読んだ結果のモデル（決定 32）。
 *
 * **値は文字列にせず、元テキストへの (offset, length) で持つ。**
 * `.unity` のシーンは 100MB になりうるので、行ごとに文字列を作ると
 * 元の 10〜20 倍のヒープになり、旧側・新側の 2 つを抱えた時点で main が落ちる
 * （docs/03-implementation-plan.md の F-1）。文字列は「表に出す 1 行」を
 * 組み立てるときだけ、その場で切り出す。
 *
 * **行番号はすべての値が持つ。** これが無いと「表の 1 行」を git の hunk / 行へ
 * 引き当てられず、パラメータ単位のステージが成立しない。汎用の YAML ライブラリを
 * 使わない最大の理由がこれ（決定 32）。
 *
 * ---
 * **メモリのための 2 つの決め事**（50MB のシーンでの実測にもとづく。M1 の受け入れ条件）
 *
 * 1. **範囲を入れ子のオブジェクトにしない。** `span: {offset, length}` にすると
 *    値 1 つにつきオブジェクトが 2 つになる。200 万行では素直に 2 倍効くので、
 *    `offset` / `length` を値そのもののフィールドにしてある。
 * 2. **フロー（`{x: 0, y: 0, z: 0}`）は分解せずスカラとして持つ。**
 *    素直に分解すると 1 行が 11 オブジェクトになり、実測でヒープが元の 14 倍に膨れた。
 *    分解が要るのは「利用者が選んだ 1 ノードの表を作るとき」だけなので、
 *    そのときに `expandFlow` で開く（F-1 の「rows は遅延生成」と同じ考え方）。
 */

/**
 * スカラの書き方。表示用の値を作るときに引用符やブロック指示子を剥がすのに使う。
 *  - `plain`  … `0` / `Player` のような素の値
 *  - `single` … `'...'`（`''` が単一の `'`）
 *  - `double` … `"..."`（`\` エスケープあり）
 *  - `flow`   … `{...}` / `[...]`。**中身はまだ分解していない**（`expandFlow` で開く）
 *  - `block`  … `|` / `>` に続く複数行
 *  - `empty`  … キーだけで値が無い
 */
export type ScalarStyle = 'plain' | 'single' | 'double' | 'flow' | 'block' | 'empty';

export interface UnityScalar {
  readonly kind: 'scalar';
  readonly startLine: number;
  readonly endLine: number;
  readonly offset: number;
  readonly length: number;
  readonly style: ScalarStyle;
}

export interface UnityEntry {
  readonly key: string;
  /** そのキーが書かれている行（1 始まり）。 */
  readonly keyLine: number;
  readonly value: UnityValue;
}

export interface UnityMapping {
  readonly kind: 'mapping';
  readonly startLine: number;
  readonly endLine: number;
  readonly offset: number;
  readonly length: number;
  readonly entries: readonly UnityEntry[];
  /** `{a: 1, b: 2}` を `expandFlow` で開いたものか。 */
  readonly flow: boolean;
}

export interface UnitySequence {
  readonly kind: 'sequence';
  readonly startLine: number;
  readonly endLine: number;
  readonly offset: number;
  readonly length: number;
  readonly items: readonly UnityValue[];
  readonly flow: boolean;
}

export type UnityValue = UnityScalar | UnityMapping | UnitySequence;

/**
 * 1 ドキュメント。`--- !u!<classId> &<anchor> [stripped]` から次の `---` の直前まで。
 *
 * `typeName` は本体の最上位キー（`GameObject:` / `Transform:` / `MonoBehaviour:`）。
 * **クラス ID から名前を引く表を持たなくて済む**のがこの形の効き目で、
 * Unity のバージョンが上がって新しいクラスが増えても表を追いかけずにすむ。
 */
export interface UnityDocument {
  /** `&` に続く fileID。**文字列で持つ**（64bit 相当で number に収まらないものがある）。 */
  readonly anchor: string;
  readonly classId: number;
  readonly stripped: boolean;
  readonly typeName: string;
  /** `---` の行。 */
  readonly startLine: number;
  readonly endLine: number;
  /**
   * 本体（クラス名の下のマッピング）の最初の行。中身が無ければ 0。
   *
   * **本体はここではパースしていない。** 145,000 ドキュメントの本体を全部
   * オブジェクトにすると 50MB のシーンでヒープが 326MB（元の 6.5 倍）になった。
   * ヒエラルキーに要るのは数個のキーだけで（`scanDocumentKey`）、
   * 全部のキーが要るのは**利用者が選んだ 1 ドキュメントだけ**（`documentBody`）。
   */
  readonly bodyStartLine: number;
  readonly bodyIndent: number;
}

export interface UnityFile {
  readonly text: string;
  /**
   * 行頭のオフセット。**1 始まりで引く**（`lineStarts[1]` が 1 行目の先頭）。
   * `lineStarts[0]` は未使用、末尾に番兵として `text.length` を置く。
   */
  readonly lineStarts: Int32Array;
  readonly lineCount: number;
  readonly documents: readonly UnityDocument[];
  /** anchor（fileID）で引く。重複していたら先に出たほうを採る。 */
  readonly byAnchor: ReadonlyMap<string, UnityDocument>;
}
