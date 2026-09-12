import { describe, expect, it } from 'vitest';
import {
  groupRefsByOid,
  layoutGraph,
  type GraphCommit,
  type GraphLine,
  type RefSource,
} from '../src/lib/commitGraph.js';

/*
 * コミットグラフのレーン割り当て（決定 20）。
 *
 * 描画そのものは見た目の問題だが、レーンの割り当てが狂うと「どのコミットがどのコミットから
 * 分岐したか」という**事実**を誤って伝えることになる。ここが純関数として切り出してある理由。
 *
 * コミットは git log と同じ「新しい順」で並べる。親は自分より後ろに来る。
 */

function c(oid: string, ...parents: string[]): GraphCommit {
  return { oid, parents };
}

/** 線の集合を比較しやすい形へ（順序に依存させない）。 */
function lineSet(lines: readonly GraphLine[]): string[] {
  return lines.map((l) => `${l.top ?? '*'}->${l.bottom ?? '*'}`).sort();
}

describe('layoutGraph', () => {
  it('一直線の履歴はレーン 0 だけを使う', () => {
    const rows = layoutGraph([c('a', 'b'), c('b', 'd'), c('d')]);

    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.width)).toEqual([1, 1, 1]);
    // 先頭は「丸から下へ」だけ、途中は「上から丸へ」＋「丸から下へ」
    expect(lineSet(rows[0]!.lines)).toEqual(['*->0']);
    expect(lineSet(rows[1]!.lines)).toEqual(['*->0', '0->*']);
    // 末尾（ルート）は親が無いので下へ出ない
    expect(lineSet(rows[2]!.lines)).toEqual(['0->*']);
  });

  it('分岐とマージで 2 レーンになり、マージ行で両方の親へ線が出る', () => {
    /*
     *   m       マージコミット（親: main 側 t、feature 側 f）
     *   ├─╮
     *   t │     main 側
     *   │ f     feature 側
     *   ├─╯
     *   b       共通の祖先
     */
    const rows = layoutGraph([c('m', 't', 'f'), c('t', 'b'), c('f', 'b'), c('b')]);

    expect(rows[0]!.lane).toBe(0);
    expect(rows[0]!.width).toBe(2);
    // マージ行: 丸から第一親（レーン 0）と第二親（レーン 1）の両方へ
    expect(lineSet(rows[0]!.lines)).toEqual(['*->0', '*->1']);

    // t はレーン 0、f はレーン 1 に載る
    expect(rows[1]!.lane).toBe(0);
    expect(rows[2]!.lane).toBe(1);
    // t の行では f のレーンが素通りする
    expect(lineSet(rows[1]!.lines)).toEqual(['*->0', '0->*', '1->1']);

    // b は 2 本のレーンが待っている。合流して 1 本になる
    expect(rows[3]!.lane).toBe(0);
    expect(lineSet(rows[3]!.lines)).toEqual(['0->*', '1->*']);
  });

  it('未マージのブランチ先端は自分のレーンを持つ（--all で拾える形）', () => {
    // feature は main のどこからも辿れない。--all だから一覧に載る
    const rows = layoutGraph([c('f', 'b'), c('a', 'b'), c('b')]);

    expect(rows[0]!.lane).toBe(0);
    expect(rows[1]!.lane).toBe(1);
    expect(rows[1]!.width).toBe(2);
    // b では 2 レーンが合流する
    expect(rows[2]!.lane).toBe(0);
    expect(lineSet(rows[2]!.lines)).toEqual(['0->*', '1->*']);
  });

  it('親を共有しない複数のルートは別のレーンに並び、空いたレーンは再利用される', () => {
    // x は独立したルート（orphan ブランチ）。x を消化するとレーン 0 が空く
    const rows = layoutGraph([c('x'), c('a', 'b'), c('b')]);

    expect(rows[0]!.lane).toBe(0);
    expect(lineSet(rows[0]!.lines)).toEqual([]); // 親も子も無い孤立コミット

    // x が終わってレーン 0 が空いたので、a はそこへ入る
    expect(rows[1]!.lane).toBe(0);
    expect(rows[1]!.width).toBe(1);
  });

  it('親が読み込み範囲の外にあっても落ちず、線は下辺へ抜ける', () => {
    // b はページに含まれていない（次のページにある）
    const rows = layoutGraph([c('a', 'b')]);

    expect(rows).toHaveLength(1);
    expect(lineSet(rows[0]!.lines)).toEqual(['*->0']);
  });

  it('空の配列を渡しても空を返す', () => {
    expect(layoutGraph([])).toEqual([]);
  });
});

describe('groupRefsByOid', () => {
  const ref = (shortName: string, oid: string, over: Partial<RefSource> = {}): RefSource => ({
    shortName,
    oid,
    isRemote: false,
    isHead: false,
    ...over,
  });

  it('同じ oid を指すブランチをまとめる', () => {
    const map = groupRefsByOid([ref('main', 'aaa'), ref('origin/main', 'aaa', { isRemote: true })]);

    expect(map.get('aaa')?.map((r) => r.name)).toEqual(['main', 'origin/main']);
    expect(map.get('bbb')).toBeUndefined();
  });

  it('今いるブランチを先頭に、ローカルをリモートより前に並べる', () => {
    const map = groupRefsByOid([
      ref('origin/main', 'aaa', { isRemote: true }),
      ref('release', 'aaa'),
      ref('main', 'aaa', { isHead: true }),
    ]);

    expect(map.get('aaa')?.map((r) => r.name)).toEqual(['main', 'release', 'origin/main']);
  });
});
