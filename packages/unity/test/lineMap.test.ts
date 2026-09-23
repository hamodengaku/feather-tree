import { describe, expect, it } from 'vitest';
import {
  buildLineIndex,
  companionRows,
  type FileDiffLike,
  parseUnityFile,
  selectionForLines,
  selectionForRow,
  selectionForRows,
  type PropertyRow,
  verifyAlignment,
} from '../src/index.js';

/*
 * 行番号 → hunk / 行の引き当て（Phase 12 M3 / 設計 A-3）。
 *
 * ここがずれると、**押した行とは別の場所が index に入る**。
 * 純関数としての振る舞いをここで固め、実際に git へ当たるところは
 * packages/core/test/unityStage.test.ts で確かめる。
 */

const LF = String.fromCharCode(10);

function text(...lines: readonly string[]): string {
  return lines.join(LF);
}

/**
 * diff を組み立てる小道具。
 *
 * **先頭 1 文字がマーカー**で、残りが行の中身（unified diff そのものの読み方）。
 * 文脈行は `' '` で始めるので、Unity の 2 字下げを書くときは**空白が 3 つ**になる。
 */
function hunk(header: string, oldStart: number, newStart: number, ...spec: readonly string[]) {
  let oldNo = oldStart;
  let newNo = newStart;
  const lines = spec.map((s) => {
    const marker = s[0];
    const body = s.slice(1);
    if (marker === '-') return { kind: 'removed', text: body, oldLineNo: oldNo++, newLineNo: null };
    if (marker === '+') return { kind: 'added', text: body, oldLineNo: null, newLineNo: newNo++ };
    if (marker === '\\') return { kind: 'no-newline', text: body, oldLineNo: null, newLineNo: null };
    return { kind: 'context', text: body, oldLineNo: oldNo++, newLineNo: newNo++ };
  });
  return { header, lines };
}

function row(
  key: string,
  oldLines: readonly number[],
  newLines: readonly number[],
): PropertyRow {
  return { key, before: null, after: null, state: 'changed', oldLines, newLines };
}

describe('1 行を引き当てる', () => {
  const diff: FileDiffLike = {
    hunks: [
      hunk('@@ -3,5 +3,5 @@', 3, 3, ' a', '-old5', '+new5', ' b', ' c'),
    ],
  };
  const index = buildLineIndex(diff);

  it('旧側の行は removed の行添字に、新側の行は added の行添字になる', () => {
    const picks = selectionForLines(index, [4], [4]);
    expect(picks).toEqual([
      { index: 0, header: '@@ -3,5 +3,5 @@', lineCount: 5, lines: [1, 2] },
    ]);
  });

  it('旧側だけを選べば removed の行だけが入る（片側ステージができる）', () => {
    expect(selectionForLines(index, [4], [])).toEqual([
      { index: 0, header: '@@ -3,5 +3,5 @@', lineCount: 5, lines: [1] },
    ]);
  });

  it('変わっていない行（文脈行）は引き当てられない', () => {
    expect(selectionForLines(index, [3], [3])).toBeNull();
    expect(selectionForLines(index, [6], [6])).toBeNull();
  });

  it('diff に無い行番号も引き当てられない', () => {
    expect(selectionForLines(index, [999], [999])).toBeNull();
  });

  it('指紋（header と lineCount）は索引を作った diff から取る', () => {
    const picks = selectionForLines(index, [4], []);
    expect(picks?.[0]?.header).toBe('@@ -3,5 +3,5 @@');
    expect(picks?.[0]?.lineCount).toBe(5);
  });
});

describe('複数 hunk にまたがる選択', () => {
  const index = buildLineIndex({
    hunks: [
      hunk('@@ -1,3 +1,3 @@', 1, 1, ' a', '-b', '+B'),
      hunk('@@ -10,3 +10,3 @@', 10, 10, ' x', '-y', '+Y'),
    ],
  });

  it('hunk 添字の昇順で、1 枚のパッチに載る形で返る', () => {
    expect(selectionForLines(index, [2, 11], [2, 11])).toEqual([
      { index: 0, header: '@@ -1,3 +1,3 @@', lineCount: 3, lines: [1, 2] },
      { index: 1, header: '@@ -10,3 +10,3 @@', lineCount: 3, lines: [1, 2] },
    ]);
  });

  it('行添字は昇順に揃える', () => {
    const picks = selectionForLines(index, [2], [2]);
    expect(picks?.[0]?.lines).toEqual([1, 2]);
  });
});

describe('末尾改行なしマーカー（行単位で選べない hunk）', () => {
  const index = buildLineIndex({
    hunks: [
      hunk('@@ -1,2 +1,2 @@', 1, 1, ' a', '-b', '+B', '\\ No newline at end of file'),
    ],
  });

  it('その hunk にかかる選択は null にする（ボタンを出さない）', () => {
    expect(selectionForLines(index, [2], [2])).toBeNull();
  });
});

describe('表の行とノードからの選択', () => {
  const index = buildLineIndex({
    hunks: [
      hunk('@@ -1,6 +1,6 @@', 1, 1, ' a', '-x1', '+X1', ' b', '-y1', '+Y1'),
    ],
  });

  it('selectionForRow は表の 1 行ぶん（「1 パラメータだけステージ」）', () => {
    expect(selectionForRow(index, row('m_X', [2], [2]))?.[0]?.lines).toEqual([1, 2]);
  });

  it('未変更行にはボタンを出さない（null）', () => {
    expect(selectionForRow(index, row('m_Same', [1], [1]))).toBeNull();
  });

  it('selectionForRows は和集合（「コンポーネントをステージ」）', () => {
    const picks = selectionForRows(index, [row('m_X', [2], [2]), row('m_Y', [4], [4])]);
    expect(picks?.[0]?.lines).toEqual([1, 2, 4, 5]);
  });

  it('和集合で重複は 1 つにまとまる（同じフロー行の兄弟）', () => {
    const picks = selectionForRows(index, [row('m_P.x', [2], [2]), row('m_P.y', [2], [2])]);
    expect(picks?.[0]?.lines).toEqual([1, 2]);
  });

  it('全行が未変更ならノードもステージできない', () => {
    expect(selectionForRows(index, [row('m_A', [1], [1]), row('m_B', [3], [3])])).toBeNull();
  });

  it('値が変わっていない行は、変わった行と同じ行に乗っていても null（要件 13）', () => {
    // フローの `{x: 変更, y: そのまま}` で y にあたる行。行としては差分に出るが、
    // 値は変わっていないのでボタンを出してはいけない
    const same: PropertyRow = {
      key: 'm_P.y',
      before: '1',
      after: '1',
      state: 'same',
      oldLines: [2],
      newLines: [2],
    };
    expect(selectionForRow(index, same)).toBeNull();
  });
});

describe('一緒に入ってしまう行（git の粒度は行まで）', () => {
  const index = buildLineIndex({
    hunks: [hunk('@@ -1,4 +1,4 @@', 1, 1, ' a', '-p', '+P', ' b')],
  });

  it('同じ行に乗る別の変更行を挙げる（押す前に分かるようにする）', () => {
    const x = row('m_P.x', [2], [2]);
    const y = row('m_P.y', [2], [2]);
    expect(companionRows(index, [x, y], x).map((r) => r.key)).toEqual(['m_P.y']);
  });

  it('自分自身は挙げない', () => {
    const x = row('m_P.x', [2], [2]);
    expect(companionRows(index, [x], x)).toHaveLength(0);
  });

  it('違う行の変更は挙げない', () => {
    const wide = buildLineIndex({
      hunks: [hunk('@@ -1,6 +1,6 @@', 1, 1, ' a', '-p', '+P', ' b', '-q', '+Q')],
    });
    const x = row('m_X', [2], [2]);
    const y = row('m_Y', [4], [4]);
    expect(companionRows(wide, [x, y], x)).toHaveLength(0);
  });

  it('未変更の行からは何も出ない', () => {
    const same: PropertyRow = {
      key: 'm_Same',
      before: '1',
      after: '1',
      state: 'same',
      oldLines: [2],
      newLines: [2],
    };
    expect(companionRows(index, [same, row('m_P.x', [2], [2])], same)).toHaveLength(0);
  });
});

describe('全文と diff の照合（A-2 / F-6）', () => {
  const HEADER = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:'] as const;
  const src = text(
    ...HEADER,
    '--- !u!4 &1',
    'Transform:',
    '  m_Enabled: 1',
    '',
  );
  const file = parseUnityFile(src);

  it('diff の行テキストが全文の同じ行と一致すれば通る', () => {
    // 文脈行なので先頭の空白 1 つはマーカー。中身は '  m_Enabled: 1'
    const diff = { hunks: [hunk('@@ -5,1 +5,1 @@', 5, 5, '   m_Enabled: 1')] };
    expect(verifyAlignment(file, diff, 'new')).toBe(true);
  });

  it('食い違えば false（ここでステージを全部止める）', () => {
    const diff = { hunks: [hunk('@@ -5,1 +5,1 @@', 5, 5, '   m_Enabled: 0')] };
    expect(verifyAlignment(file, diff, 'new')).toBe(false);
  });

  it('CRLF の CR だけの違いは通す（改行コードで機能を止めない）', () => {
    const crlfFile = parseUnityFile(src.split(LF).join(String.fromCharCode(13) + LF));
    const diff = { hunks: [hunk('@@ -5,1 +5,1 @@', 5, 5, '   m_Enabled: 1')] };
    expect(verifyAlignment(crlfFile, diff, 'new')).toBe(true);
  });

  it('全文より後ろの行を指していれば false', () => {
    const diff = { hunks: [hunk('@@ -99,1 +99,1 @@', 99, 99, '   m_Enabled: 1')] };
    expect(verifyAlignment(file, diff, 'new')).toBe(false);
  });

  it('旧側は oldLineNo で照合する', () => {
    const diff = { hunks: [hunk('@@ -5,1 +5,2 @@', 5, 5, '-  m_Enabled: 1', '+  m_Enabled: 0')] };
    expect(verifyAlignment(file, diff, 'old')).toBe(true);
    expect(verifyAlignment(file, diff, 'new')).toBe(false);
  });
});
