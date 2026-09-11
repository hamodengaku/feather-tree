import { describe, expect, it } from 'vitest';
import type { DiffLineDto, FileDiffDto } from '@feathertree/ipc';
import {
  hunkAllowsLines,
  singleLineSelection,
  wholeHunkSelection,
} from '../src/lib/diffSelection.js';

function line(kind: DiffLineDto['kind'], text: string): DiffLineDto {
  return { kind, text, oldLineNo: null, newLineNo: null };
}

/** 2 hunk。各 hunk は 文脈 / 削除 / 追加 / 文脈 の 4 行。 */
function twoHunks(): FileDiffDto {
  const body = (n: string): DiffLineDto[] => [
    line('context', 'ctx' + n),
    line('removed', 'old' + n),
    line('added', 'new' + n),
    line('context', 'tail' + n),
  ];
  return {
    path: 'a.txt',
    oldPath: null,
    binary: false,
    truncated: false,
    hunkStageable: true,
    hunks: [
      { header: '@@ -1,3 +1,3 @@', oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: body('1') },
      { header: '@@ -10,3 +10,3 @@', oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: body('2') },
    ],
  };
}

describe('hunk / 行の指定づくり', () => {
  describe('hunkAllowsLines', () => {
    it('通常の hunk は行単位を許す', () => {
      expect(hunkAllowsLines(twoHunks(), 0)).toBe(true);
    });

    it('末尾改行なしマーカーを含む hunk は許さない', () => {
      const diff = twoHunks();
      const withMarker: FileDiffDto = {
        ...diff,
        hunks: [
          { ...diff.hunks[0]!, lines: [...diff.hunks[0]!.lines, line('no-newline', 'No newline')] },
          diff.hunks[1]!,
        ],
      };

      expect(hunkAllowsLines(withMarker, 0)).toBe(false);
      expect(hunkAllowsLines(withMarker, 1)).toBe(true);
    });

    it('存在しない hunk は許さない', () => {
      expect(hunkAllowsLines(twoHunks(), 9)).toBe(false);
    });
  });

  describe('wholeHunkSelection', () => {
    it('lines: null（hunk 全体）を指紋つきで 1 件返す', () => {
      expect(wholeHunkSelection(twoHunks(), 1)).toEqual([
        { index: 1, header: '@@ -10,3 +10,3 @@', lineCount: 4, lines: null },
      ]);
    });

    it('存在しない hunk なら空', () => {
      expect(wholeHunkSelection(twoHunks(), 9)).toEqual([]);
    });
  });

  describe('singleLineSelection', () => {
    it('押された 1 行だけを指紋つきで返す', () => {
      expect(singleLineSelection(twoHunks(), 1, 2)).toEqual([
        { index: 1, header: '@@ -10,3 +10,3 @@', lineCount: 4, lines: [2] },
      ]);
    });

    it('対になる行は含めない（押した行だけ）', () => {
      const sent = singleLineSelection(twoHunks(), 0, 2);
      expect(sent[0]?.lines).toEqual([2]);
    });

    it('文脈行は対象外', () => {
      expect(singleLineSelection(twoHunks(), 0, 0)).toEqual([]);
      expect(singleLineSelection(twoHunks(), 0, 3)).toEqual([]);
    });

    it('存在しない hunk / 行なら空', () => {
      expect(singleLineSelection(twoHunks(), 9, 0)).toEqual([]);
      expect(singleLineSelection(twoHunks(), 0, 99)).toEqual([]);
    });
  });
});
