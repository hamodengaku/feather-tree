/*
 * 行の対応付け（決定 33 / EA-2）。新旧の行の指紋の並びから、「どの行とどの行が対か」を決める。
 *
 *   1. 前後の一致を刈り込む（大半が同じ表はここでほぼ終わる）
 *   2. **一意行アンカー（patience）**: 両側でちょうど 1 回だけ現れる指紋の組を、順序を保つ最長の列（LIS）で
 *      つなぐ。ID 列を持つゲームデータ表は、ここでよく揃う
 *   3. アンカーの間は Myers の差分で詰める。**予算**（編集距離 D と (n+m)·D）を超えた区間は
 *      位置で対にして、`positional` の印を立てる（全面的に変わった表で止まらないため）
 *   4. 対にならなかった「削除 k 行 + 挿入 m 行」の並びは、**似かた（同じ値の列の割合）**の合計が最大に
 *      なるように、順序を保って「変更」の対を選ぶ（半分以上が同じ組だけ）。残りは削除 / 追加。
 *      似た組が無く k = m なら先頭から順に対にする（同じ位置の行をまるごと書き換えた場合）
 *
 * 出力は揃えた後の並び（旧の行番号・新の行番号。片側に無ければ -1）。「同じ」か「変更」かは、
 * 呼び出し側が実セルを比べて決める（指紋の衝突で「同じ」と誤判定しないため）。
 */

import type { ExcelLimits } from '../limits.js';
import { EMPTY_ROW_KEY } from './rowKey.js';

export interface Alignment {
  readonly oldRow: Int32Array;
  readonly newRow: Int32Array;
  /** 予算を超えて位置で対にした区間があった。 */
  readonly positional: boolean;
}

type Budget = Pick<ExcelLimits, 'maxAlignEdits' | 'maxAlignWork'>;

/** 編集操作。対応付けの途中でだけ使う。 */
const OP_EQUAL = 0;
const OP_DELETE = 1;
const OP_INSERT = 2;

class OpList {
  kind: number[] = [];
  a: number[] = [];
  b: number[] = [];

  push(kind: number, a: number, b: number): void {
    this.kind.push(kind);
    this.a.push(a);
    this.b.push(b);
  }
}

/**
 * 旧の行 a と新の行 b の似ている度合い（0〜1）。削除と挿入が並んだ区間で「どの行とどの行を
 * 変更の対にするか」を決めるのに使う。渡されなければ先頭から順に対にする。
 */
export type RowSimilarity = (oldRow: number, newRow: number) => number;

/** これ未満の似かたは対にしない（別の行の削除と追加として出す）。 */
const PAIR_THRESHOLD = 0.5;
/** 似かたで対を探す区間の大きさの上限（k × m）。超えたら先頭から順に対にする。 */
const PAIR_SEARCH_LIMIT = 250_000;

export function alignRows(
  oldKeys: ArrayLike<number>,
  newKeys: ArrayLike<number>,
  budget: Budget,
  similarity?: RowSimilarity,
): Alignment {
  // 指紋を小さな整数 ID に写す（Myers と LIS は整数の比較だけで回したい）
  const ids = new Map<number, number>();
  const toIds = (keys: ArrayLike<number>): Int32Array => {
    const out = new Int32Array(keys.length);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i] ?? 0;
      let id = ids.get(k);
      if (id === undefined) {
        id = ids.size;
        ids.set(k, id);
      }
      out[i] = id;
    }
    return out;
  };
  const a = toIds(oldKeys);
  const b = toIds(newKeys);

  const ops = new OpList();
  // 空の行の ID はアンカーにしない。両側に空の行が 1 つずつしか無いと「一意」になってしまい、
  // 無関係な空行どうしを揃えてしまう
  const state = { positional: false, emptyId: ids.get(EMPTY_ROW_KEY) ?? -1 };
  diffRange(a, 0, a.length, b, 0, b.length, ops, budget, state, true);
  return pairUp(ops, state.positional, similarity);
}

function diffRange(
  a: Int32Array,
  aLo: number,
  aHi: number,
  b: Int32Array,
  bLo: number,
  bHi: number,
  ops: OpList,
  budget: Budget,
  state: { positional: boolean; readonly emptyId: number },
  useAnchors: boolean,
): void {
  // 前の一致
  let pre = 0;
  while (aLo + pre < aHi && bLo + pre < bHi && a[aLo + pre] === b[bLo + pre]) pre += 1;
  for (let i = 0; i < pre; i += 1) ops.push(OP_EQUAL, aLo + i, bLo + i);
  aLo += pre;
  bLo += pre;
  // 後ろの一致（出力は最後に回す）
  let post = 0;
  while (aHi - post > aLo && bHi - post > bLo && a[aHi - post - 1] === b[bHi - post - 1]) post += 1;
  const aEnd = aHi - post;
  const bEnd = bHi - post;

  if (aLo === aEnd) {
    for (let j = bLo; j < bEnd; j += 1) ops.push(OP_INSERT, -1, j);
  } else if (bLo === bEnd) {
    for (let i = aLo; i < aEnd; i += 1) ops.push(OP_DELETE, i, -1);
  } else {
    const anchors = useAnchors ? uniqueAnchors(a, aLo, aEnd, b, bLo, bEnd, state.emptyId) : null;
    if (anchors !== null && anchors.length > 0) {
      let pa = aLo;
      let pb = bLo;
      for (const [ia, ib] of anchors) {
        diffRange(a, pa, ia, b, pb, ib, ops, budget, state, false);
        ops.push(OP_EQUAL, ia, ib);
        pa = ia + 1;
        pb = ib + 1;
      }
      diffRange(a, pa, aEnd, b, pb, bEnd, ops, budget, state, false);
    } else if (!myers(a, aLo, aEnd, b, bLo, bEnd, ops, budget)) {
      state.positional = true;
      positional(aLo, aEnd, bLo, bEnd, ops);
    }
  }

  for (let i = 0; i < post; i += 1) ops.push(OP_EQUAL, aEnd + i, bEnd + i);
}

/** 両側で 1 回だけ現れる ID の組を、順序を保つ最長の列で返す。 */
function uniqueAnchors(
  a: Int32Array,
  aLo: number,
  aHi: number,
  b: Int32Array,
  bLo: number,
  bHi: number,
  emptyId: number,
): Array<readonly [number, number]> | null {
  // ID → 出現位置（2 回目以降は -2）
  const inA = new Map<number, number>();
  for (let i = aLo; i < aHi; i += 1) {
    const id = a[i] ?? 0;
    inA.set(id, inA.has(id) ? -2 : i);
  }
  const inB = new Map<number, number>();
  for (let j = bLo; j < bHi; j += 1) {
    const id = b[j] ?? 0;
    inB.set(id, inB.has(id) ? -2 : j);
  }
  const pairs: Array<readonly [number, number]> = [];
  for (let i = aLo; i < aHi; i += 1) {
    const id = a[i] ?? 0;
    const pa = inA.get(id);
    const pb = inB.get(id);
    if (id !== emptyId && pa === i && pb !== undefined && pb >= 0) pairs.push([i, pb]);
  }
  if (pairs.length === 0) return null;
  return longestIncreasing(pairs);
}

/** b 側の位置が増えていく最長の部分列（O(n log n)）。 */
function longestIncreasing(pairs: Array<readonly [number, number]>): Array<readonly [number, number]> {
  const tails: number[] = []; // 長さ k+1 の列の末尾の pairs 添字
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i += 1) {
    const v = pairs[i]?.[1] ?? 0;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((pairs[tails[mid] ?? 0]?.[1] ?? 0) < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] ?? -1;
    tails[lo] = i;
  }
  const out: Array<readonly [number, number]> = [];
  let k = tails[tails.length - 1] ?? -1;
  while (k >= 0) {
    const p = pairs[k];
    if (p !== undefined) out.push(p);
    k = prev[k] ?? -1;
  }
  out.reverse();
  return out;
}

/**
 * Myers の O(ND) 差分。予算を超えたら false（何も出力しない）。
 * trace には各 d の後の V の [-d, d] を保存し、後ろから辿って編集操作を出す。
 */
function myers(
  a: Int32Array,
  aLo: number,
  aHi: number,
  b: Int32Array,
  bLo: number,
  bHi: number,
  ops: OpList,
  budget: Budget,
): boolean {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const max = Math.min(n + m, budget.maxAlignEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;

  for (let d = 0; d <= max; d += 1) {
    if ((n + m) * d > budget.maxAlignWork) return false;
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) {
        x = v[offset + k + 1] ?? 0;
      } else {
        x = (v[offset + k - 1] ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
    if (found >= 0) break;
  }
  if (found < 0) return false;

  // 後ろから辿る
  const rev = new OpList();
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prevV = trace[d - 1];
    if (prevV === undefined) return false;
    // trace[d-1] は k ∈ [-(d-1), d-1] を持つ
    const at = (k: number): number => prevV[k + d - 1] ?? 0;
    const k = x - y;
    // 下へ動いた（挿入）か、右へ動いた（削除）か。前進のときと同じ判定
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    // 1 手を打った直後の位置。そこから (x, y) までは斜め（一致）
    const stepX = down ? prevX : prevX + 1;
    while (x > stepX) {
      x -= 1;
      y -= 1;
      rev.push(OP_EQUAL, aLo + x, bLo + y);
    }
    if (down) {
      rev.push(OP_INSERT, -1, bLo + prevY);
    } else {
      rev.push(OP_DELETE, aLo + prevX, -1);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    rev.push(OP_EQUAL, aLo + x, bLo + y);
  }
  for (let i = rev.kind.length - 1; i >= 0; i -= 1) {
    ops.push(rev.kind[i] ?? OP_EQUAL, rev.a[i] ?? -1, rev.b[i] ?? -1);
  }
  return true;
}

function positional(aLo: number, aHi: number, bLo: number, bHi: number, ops: OpList): void {
  const both = Math.min(aHi - aLo, bHi - bLo);
  for (let i = 0; i < both; i += 1) {
    ops.push(OP_DELETE, aLo + i, -1);
    ops.push(OP_INSERT, -1, bLo + i);
  }
  for (let i = aLo + both; i < aHi; i += 1) ops.push(OP_DELETE, i, -1);
  for (let j = bLo + both; j < bHi; j += 1) ops.push(OP_INSERT, -1, j);
}

/**
 * 一致の間に挟まった削除と挿入を「変更」の対にする。
 *
 * 似かたの関数があれば、順序を保ったまま似かたの合計が最大になる組を動的計画法で選ぶ
 * （行を 1 つ挿入して、その下の行を書き換えた、という普通の編集で、挿入した行と書き換えた行を
 * 取り違えないため）。似た組が 1 つも無く、削除と挿入が同数なら、先頭から順に対にする
 * （同じ位置の行をまるごと書き換えた場合）。区間が大きすぎるときも先頭から順に対にする。
 */
function pairUp(ops: OpList, positionalFlag: boolean, similarity?: RowSimilarity): Alignment {
  const oldOut: number[] = [];
  const newOut: number[] = [];
  const dels: number[] = [];
  const ins: number[] = [];

  const emit = (o: number, n: number): void => {
    oldOut.push(o);
    newOut.push(n);
  };

  const flushInOrder = (): void => {
    const both = Math.min(dels.length, ins.length);
    for (let i = 0; i < both; i += 1) emit(dels[i] ?? -1, ins[i] ?? -1);
    for (let i = both; i < dels.length; i += 1) emit(dels[i] ?? -1, -1);
    for (let i = both; i < ins.length; i += 1) emit(-1, ins[i] ?? -1);
  };

  const flush = (): void => {
    const k = dels.length;
    const m = ins.length;
    const pairs = similarity !== undefined && k > 0 && m > 0 && k * m <= PAIR_SEARCH_LIMIT ? bestPairs(dels, ins, similarity) : null;
    if (pairs === null || (pairs.length === 0 && k === m)) {
      flushInOrder();
    } else {
      // 対の手前にある対にならない行は、削除 → 追加の順に出す
      let i = 0;
      let j = 0;
      for (const [pi, pj] of pairs) {
        while (i < pi) emit(dels[i++] ?? -1, -1);
        while (j < pj) emit(-1, ins[j++] ?? -1);
        emit(dels[i++] ?? -1, ins[j++] ?? -1);
      }
      while (i < k) emit(dels[i++] ?? -1, -1);
      while (j < m) emit(-1, ins[j++] ?? -1);
    }
    dels.length = 0;
    ins.length = 0;
  };

  for (let i = 0; i < ops.kind.length; i += 1) {
    const kind = ops.kind[i];
    if (kind === OP_EQUAL) {
      flush();
      oldOut.push(ops.a[i] ?? -1);
      newOut.push(ops.b[i] ?? -1);
    } else if (kind === OP_DELETE) {
      dels.push(ops.a[i] ?? -1);
    } else {
      ins.push(ops.b[i] ?? -1);
    }
  }
  flush();
  return { oldRow: Int32Array.from(oldOut), newRow: Int32Array.from(newOut), positional: positionalFlag };
}

/**
 * 順序を保つ対の選び方のうち、似かた（閾値以上のものだけ）の合計が最大のもの。
 * 返すのは dels / ins の中の添字の組。O(k × m)。
 */
function bestPairs(dels: readonly number[], ins: readonly number[], similarity: RowSimilarity): Array<[number, number]> {
  const k = dels.length;
  const m = ins.length;
  const width = m + 1;
  const score = new Float64Array((k + 1) * width);
  const sim = new Float64Array(k * m);
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < m; j += 1) sim[i * m + j] = similarity(dels[i] ?? -1, ins[j] ?? -1);
  }
  for (let i = 1; i <= k; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const up = score[(i - 1) * width + j] ?? 0;
      const left = score[i * width + j - 1] ?? 0;
      const s = sim[(i - 1) * m + (j - 1)] ?? 0;
      const diag = s >= PAIR_THRESHOLD ? (score[(i - 1) * width + j - 1] ?? 0) + s : -1;
      score[i * width + j] = Math.max(up, left, diag);
    }
  }
  const out: Array<[number, number]> = [];
  let i = k;
  let j = m;
  while (i > 0 && j > 0) {
    const here = score[i * width + j] ?? 0;
    const s = sim[(i - 1) * m + (j - 1)] ?? 0;
    if (s >= PAIR_THRESHOLD && here === (score[(i - 1) * width + j - 1] ?? 0) + s) {
      out.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (here === (score[(i - 1) * width + j] ?? 0)) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  out.reverse();
  return out;
}
