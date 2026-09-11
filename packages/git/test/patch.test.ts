import { describe, expect, it } from 'vitest';
import {
  buildHunkPatch,
  canBuildPatch,
  hunkAllowsLineSelection,
  PatchBuildError,
  parseUnifiedDiff,
  type FileDiff,
} from '../src/index.js';

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
/** 「\ No newline at end of file」の行頭。ヒアドキュメント経由で縮むのを避ける。 */
const BACKSLASH = String.fromCharCode(92);

/** git の生出力から FileDiff を作る（パーサと生成器の往復を 1 本で確かめるため）。 */
function fromRaw(lines: readonly string[]): FileDiff {
  const files = parseUnifiedDiff(lines.join(LF) + LF);
  const first = files[0];
  if (first === undefined) throw new Error('パースできませんでした');
  return first;
}

const HEADER = ['diff --git a/a.txt b/a.txt', 'index 1111111..2222222 100644', '--- a/a.txt', '+++ b/a.txt'];

describe('パッチ生成器 (対応表 #33 / #34)', () => {
  describe('hunk 全体', () => {
    it('元の hunk をそのまま再生する（ヘッダのカウントも一致）', () => {
      const raw = [...HEADER, '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three'];
      const diff = fromRaw(raw);

      const { patch, changedLines } = buildHunkPatch(diff, [{ index: 0, lines: null }], 'stage');

      expect(patch).toBe(raw.join(LF) + LF);
      expect(changedLines).toBe(2);
    });

    it('unstage 方向でも同じパッチになる（反転は git の --reverse に任せる）', () => {
      const raw = [...HEADER, '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three'];
      const diff = fromRaw(raw);

      const forward = buildHunkPatch(diff, [{ index: 0, lines: null }], 'stage');
      const reverse = buildHunkPatch(diff, [{ index: 0, lines: null }], 'unstage');

      expect(reverse.patch).toBe(forward.patch);
    });
  });

  describe('行単位（stage 方向）', () => {
    // pre-image = old 側なので、選ばなかった added は捨て、選ばなかった removed は文脈に落とす
    const raw = [...HEADER, '@@ -1,4 +1,4 @@', ' keep', '-old1', '-old2', '+new1', '+new2', ' tail'];

    it('選んだ added だけ残し、他の added は捨てる', () => {
      const diff = fromRaw(raw);
      // lines: 0=keep, 1=-old1, 2=-old2, 3=+new1, 4=+new2, 5=tail
      const { patch, changedLines } = buildHunkPatch(diff, [{ index: 0, lines: [3] }], 'stage');

      expect(patch.split(LF)).toEqual([
        ...HEADER,
        // old 側 4 行（keep/old1/old2/tail）、new 側 5 行（そこへ new1 が増える）。
        // new1 は「1 番目の削除に対応する追加」なので old1 の直後に入る
        '@@ -1,4 +1,5 @@',
        ' keep',
        ' old1',
        '+new1',
        ' old2',
        ' tail',
        '',
      ]);
      expect(changedLines).toBe(1);
    });

    it('選んだ removed だけ削除し、他の removed は文脈に落とす', () => {
      const diff = fromRaw(raw);
      const { patch } = buildHunkPatch(diff, [{ index: 0, lines: [1] }], 'stage');

      expect(patch.split(LF)).toEqual([
        ...HEADER,
        '@@ -1,4 +1,3 @@',
        ' keep',
        '-old1',
        ' old2',
        ' tail',
        '',
      ]);
    });
  });

  describe('行単位（unstage 方向）', () => {
    // pre-image = new 側なので、stage 方向と役割がちょうど入れ替わる
    const raw = [...HEADER, '@@ -1,4 +1,4 @@', ' keep', '-old1', '-old2', '+new1', '+new2', ' tail'];

    it('選ばなかった added は文脈に落とす（index には在るため）', () => {
      const diff = fromRaw(raw);
      const { patch } = buildHunkPatch(diff, [{ index: 0, lines: [3] }], 'unstage');

      expect(patch.split(LF)).toEqual([
        ...HEADER,
        '@@ -1,3 +1,4 @@',
        ' keep',
        '+new1',
        ' new2',
        ' tail',
        '',
      ]);
    });

    it('選ばなかった removed は捨てる（index に無いため）', () => {
      const diff = fromRaw(raw);
      const { patch } = buildHunkPatch(diff, [{ index: 0, lines: [1] }], 'unstage');

      // 非選択の added は index に在るので文脈として残り、非選択の removed だけが消える
      expect(patch.split(LF)).toEqual([
        ...HEADER,
        '@@ -1,5 +1,4 @@',
        ' keep',
        '-old1',
        ' new1',
        ' new2',
        ' tail',
        '',
      ]);
    });
  });

  describe('複数 hunk', () => {
    const raw = [
      ...HEADER,
      '@@ -1,3 +1,4 @@',
      ' a1',
      '+added-1',
      ' a2',
      ' a3',
      '@@ -10,3 +11,4 @@',
      ' b1',
      '+added-2',
      ' b2',
      ' b3',
    ];

    it('2 つめ以降は非権威側の開始行に累積のずれを足す', () => {
      const diff = fromRaw(raw);
      const { patch } = buildHunkPatch(
        diff,
        [
          { index: 0, lines: null },
          { index: 1, lines: null },
        ],
        'stage',
      );

      const headers = patch.split(LF).filter((l) => l.startsWith('@@'));
      // stage 方向の権威側は old。1 つめで +1 行ずれるので 2 つめの new 側は 10 + 1 = 11
      expect(headers).toEqual(['@@ -1,3 +1,4 @@', '@@ -10,3 +11,4 @@']);
    });

    it('1 つめだけ選ぶと、2 つめは出ずずれも生じない', () => {
      const diff = fromRaw(raw);
      const { patch, changedLines } = buildHunkPatch(diff, [{ index: 1, lines: null }], 'stage');

      const headers = patch.split(LF).filter((l) => l.startsWith('@@'));
      expect(headers).toEqual(['@@ -10,3 +10,4 @@']);
      expect(changedLines).toBe(1);
    });

    it('変更行が残らない hunk は出力せず、ずれにも寄与しない', () => {
      const diff = fromRaw(raw);
      const { patch } = buildHunkPatch(
        diff,
        [
          { index: 0, lines: [] },
          { index: 1, lines: null },
        ],
        'stage',
      );

      const headers = patch.split(LF).filter((l) => l.startsWith('@@'));
      // 空振りした 1 つめは消え、2 つめのずれは 0 のまま
      expect(headers).toEqual(['@@ -10,3 +10,4 @@']);
    });

    it('picks の順番が逆でも hunk 順に並べ直す', () => {
      const diff = fromRaw(raw);
      const { patch } = buildHunkPatch(
        diff,
        [
          { index: 1, lines: null },
          { index: 0, lines: null },
        ],
        'stage',
      );

      const headers = patch.split(LF).filter((l) => l.startsWith('@@'));
      expect(headers).toEqual(['@@ -1,3 +1,4 @@', '@@ -10,3 +11,4 @@']);
    });
  });

  describe('特殊な行', () => {
    it('CRLF ファイルでは CR が本文の一部として保存される', () => {
      const raw = [...HEADER, '@@ -1,2 +1,2 @@', ' one' + CR, '-two' + CR, '+TWO' + CR];
      const diff = fromRaw(raw);

      const { patch } = buildHunkPatch(diff, [{ index: 0, lines: null }], 'stage');

      expect(patch).toBe(raw.join(LF) + LF);
      expect(patch).toContain('+TWO' + CR + LF);
    });

    it('末尾改行なしマーカーは、親の行を出したときだけ付いていく', () => {
      const raw = [
        ...HEADER,
        '@@ -1,2 +1,2 @@',
        ' one',
        '-two',
        BACKSLASH + ' No newline at end of file',
        '+TWO',
      ];
      const diff = fromRaw(raw);

      const { patch } = buildHunkPatch(diff, [{ index: 0, lines: null }], 'stage');
      expect(patch.split(LF)).toContain(BACKSLASH + ' No newline at end of file');
    });

    it('親の行を捨てるとマーカーも道連れで落ちる', () => {
      const raw = [
        ...HEADER,
        '@@ -1,2 +1,2 @@',
        ' one',
        '-two',
        '+TWO',
        BACKSLASH + ' No newline at end of file',
      ];
      const diff = fromRaw(raw);

      // +TWO(index 2) を選ばない → unstage 方向では文脈化されるので残る
      // stage 方向では捨てられ、直後のマーカーも消える
      const { patch } = buildHunkPatch(diff, [{ index: 0, lines: [1] }], 'stage');
      expect(patch.split(LF).some((l) => l.startsWith(BACKSLASH))).toBe(false);
    });

    it('末尾改行なしを含む hunk は行単位選択を許さない', () => {
      const diff = fromRaw([
        ...HEADER,
        '@@ -1,2 +1,2 @@',
        ' one',
        '-two',
        BACKSLASH + ' No newline at end of file',
        '+TWO',
      ]);

      expect(hunkAllowsLineSelection(diff, 0)).toBe(false);
    });

    it('通常の hunk は行単位選択を許す', () => {
      const diff = fromRaw([...HEADER, '@@ -1,2 +1,2 @@', ' one', '-two', '+TWO']);
      expect(hunkAllowsLineSelection(diff, 0)).toBe(true);
    });

    it('日本語の本文とパスをそのまま通す', () => {
      const header = [
        'diff --git a/日本語 ファイル.txt b/日本語 ファイル.txt',
        'index 1111111..2222222 100644',
        '--- a/日本語 ファイル.txt',
        '+++ b/日本語 ファイル.txt',
      ];
      const raw = [...header, '@@ -1,2 +1,2 @@', ' 変わらない行', '-古い行', '+新しい行'];
      const diff = fromRaw(raw);

      const { patch } = buildHunkPatch(diff, [{ index: 0, lines: null }], 'stage');
      expect(patch).toBe(raw.join(LF) + LF);
    });
  });

  describe('canBuildPatch の拒否', () => {
    const base = fromRaw([...HEADER, '@@ -1,2 +1,2 @@', ' one', '-two', '+TWO']);

    it('通常の変更は許可する', () => {
      expect(canBuildPatch(base)).toBeNull();
    });

    it.each([
      ['binary', { ...base, binary: true }],
      ['truncated', { ...base, truncated: true }],
      ['synthesized', { ...base, preamble: [] }],
      ['no-hunk', { ...base, hunks: [] }],
      ['whole-file', { ...base, preamble: [...HEADER.slice(0, 2), 'new file mode 100644'] }],
      ['whole-file', { ...base, preamble: [...HEADER.slice(0, 2), '--- /dev/null'] }],
      ['whole-file', { ...base, preamble: [...HEADER.slice(0, 2), 'deleted file mode 100644'] }],
      ['rename', { ...base, preamble: [...HEADER.slice(0, 2), 'rename from x.txt', 'rename to y.txt'] }],
      ['combined', { ...base, preamble: ['diff --cc a.txt'] }],
    ] as const)('%s を拒否する', (expected, diff) => {
      expect(canBuildPatch(diff)).toBe(expected);
      expect(() => buildHunkPatch(diff, [{ index: 0, lines: null }], 'stage')).toThrow(PatchBuildError);
    });

    it('選択が空なら empty-selection', () => {
      expect(() => buildHunkPatch(base, [{ index: 0, lines: [] }], 'stage')).toThrow(
        expect.objectContaining({ refusal: 'empty-selection' }),
      );
    });

    it('存在しない hunk を指すと no-such-hunk', () => {
      expect(() => buildHunkPatch(base, [{ index: 9 }, { index: 0, lines: null }].map((p) => ({ ...p, lines: null })), 'stage')).toThrow(
        expect.objectContaining({ refusal: 'no-such-hunk' }),
      );
    });
  });
});
