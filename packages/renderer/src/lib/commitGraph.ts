/**
 * コミットグラフのレーン割り当て（決定 20）。
 *
 * **純関数。取得済みのコミット配列だけから決まる。** 描画のために git を増やさない
 * （docs/01-architecture.md 8 章）。追加ページを読み込んだら全体を計算し直せばよく、
 * 計算量は件数に比例する。
 *
 * レーンは `git log --graph` と同じ考え方で、「次に現れるはずのコミット（oid）を待っている縦の筋」。
 * 1 行進むごとに、その行のコミットを待っていた筋が丸に吸い込まれ、代わりに親を待つ筋が出ていく。
 *
 * 設計上の要は **一度決めたレーンの添字を詰め直さないこと**。
 * 空いたレーンは null のまま穴として残し、後続のコミットが再利用する。
 * こうすると「上から下へただ通過するだけの筋」は必ず同じ添字に居続けるので、
 * 描く線が下の 3 種類だけに閉じる:
 *
 *   1. 合流  上辺のレーン → 丸       （このコミットを待っていた筋）
 *   2. 通過  上辺のレーン → 同じ添字の下辺（無関係な筋）
 *   3. 分岐  丸 → 下辺のレーン       （このコミットの親を待つ筋）
 */

/** 1 本の線。端が null なら「コミットの丸」に繋がる。 */
export interface GraphLine {
  /** 行の上辺のレーン添字。null なら丸から出る。 */
  readonly top: number | null;
  /** 行の下辺のレーン添字。null なら丸へ入る。 */
  readonly bottom: number | null;
}

export interface GraphRow {
  /** このコミットの丸を置くレーン添字。 */
  readonly lane: number;
  /** この行の描画に必要なレーン数（上辺・下辺・丸の位置のうち最大）。 */
  readonly width: number;
  readonly lines: readonly GraphLine[];
}

/** レーン計算に必要な最小限。CommitSummaryDto をそのまま渡せる。 */
export interface GraphCommit {
  readonly oid: string;
  readonly parents: readonly string[];
}

/** コミット行に出すブランチ先端の名札。 */
export interface CommitRef {
  readonly name: string;
  readonly isRemote: boolean;
  readonly isHead: boolean;
}

/** 名札の並び順に必要な最小限。BranchDto をそのまま渡せる。 */
export interface RefSource {
  readonly shortName: string;
  readonly isRemote: boolean;
  readonly isHead: boolean;
  readonly oid: string;
}

export const NO_REFS: readonly CommitRef[] = [];

/**
 * ブランチ一覧（対応表 #3 の結果）を oid で引ける形に組み替える。
 *
 * **これがあるので #20 のフォーマットに `%D` を足す必要がない。** 先端の名前は
 * すでに取得済みのブランチ一覧が持っているので、履歴のために git を増やさずに済む
 * （docs/01-architecture.md 8 章）。
 *
 * 並びは「今いるブランチ → ローカル → リモート」。行の左端に来る名札が
 * いちばん重要なものになるようにする。
 */
export function groupRefsByOid(branches: readonly RefSource[]): Map<string, CommitRef[]> {
  const map = new Map<string, CommitRef[]>();
  for (const b of branches) {
    const list = map.get(b.oid) ?? [];
    list.push({ name: b.shortName, isRemote: b.isRemote, isHead: b.isHead });
    map.set(b.oid, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => Number(b.isHead) - Number(a.isHead) || Number(a.isRemote) - Number(b.isRemote));
  }
  return map;
}

/** 空きレーン（null の穴）を探す。無ければ末尾に足す。 */
function firstFree(lanes: (string | null)[]): number {
  const hole = lanes.indexOf(null);
  if (hole !== -1) return hole;
  lanes.push(null);
  return lanes.length - 1;
}

/**
 * コミット列（git log の出力順）にレーンを割り当てる。
 *
 * 親が読み込み範囲の外にある場合、その筋は行の下辺まで線を引いたまま終わる。
 * これは「まだ読み込んでいない先へ続いている」ことの正しい見え方なので、特別扱いしない。
 */
export function layoutGraph(commits: readonly GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const incoming = [...lanes];

    // ① 自分を待っているレーン。無ければ新しく立てる（ブランチの先端・孤立したコミット）
    let lane = incoming.indexOf(commit.oid);
    if (lane === -1) {
      lane = firstFree(lanes);
      lanes[lane] = commit.oid;
    }

    // ② 同じ oid を待っている他のレーンは、ここで合流して空く
    for (let i = 0; i < lanes.length; i += 1) {
      if (i !== lane && lanes[i] === commit.oid) lanes[i] = null;
    }

    // ③ 第一親は自分のレーンをそのまま継ぐ。第二親以降は既存の待ちレーンか、空き穴へ
    const parentLanes: number[] = [];
    lanes[lane] = commit.parents[0] ?? null;
    if (commit.parents.length > 0) parentLanes.push(lane);

    for (let k = 1; k < commit.parents.length; k += 1) {
      const parent = commit.parents[k];
      if (parent === undefined) continue;
      const existing = lanes.indexOf(parent);
      if (existing !== -1) {
        parentLanes.push(existing);
        continue;
      }
      const slot = firstFree(lanes);
      lanes[slot] = parent;
      parentLanes.push(slot);
    }

    // 末尾の空きは畳んでおく（グラフの幅が使われないまま広がり続けないように）
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    const lines: GraphLine[] = [];
    for (let i = 0; i < incoming.length; i += 1) {
      const waiting = incoming[i];
      if (waiting === null || waiting === undefined) continue;
      // 自分を待っていた筋は丸へ吸い込まれる。それ以外は添字が動かないので真っ直ぐ通す
      if (waiting === commit.oid) lines.push({ top: i, bottom: null });
      else lines.push({ top: i, bottom: i });
    }
    for (const parentLane of parentLanes) lines.push({ top: null, bottom: parentLane });

    rows.push({
      lane,
      width: Math.max(incoming.length, lanes.length, lane + 1),
      lines,
    });
  }

  return rows;
}
