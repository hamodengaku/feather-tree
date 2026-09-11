import { describe, expect, it } from 'vitest';
import type { FileEntryDto } from '@feathertree/ipc';
import {
  EMPTY_SELECTION,
  nextSelection,
  nextSelectionAfterRemoval,
  type SelectionState,
} from '../src/lib/selection.js';
import { entry } from './fakeBridge.js';

const ENTRIES: (FileEntryDto | undefined)[] = [
  entry('a.txt'),
  entry('b.txt'),
  entry('c.txt'),
  entry('d.txt'),
  entry('e.txt'),
];

describe('nextSelection', () => {
  it('修飾キー無しは単独選択に置き換える', () => {
    const state: SelectionState = { selected: new Set(['a.txt', 'b.txt']), anchorIndex: 0 };
    const next = nextSelection(state, { index: 2, path: 'c.txt', ctrlKey: false, shiftKey: false }, ENTRIES);
    expect(next.selected).toEqual(new Set(['c.txt']));
    expect(next.anchorIndex).toBe(2);
  });

  it('Ctrl クリックはトグルする（追加）', () => {
    const next = nextSelection(EMPTY_SELECTION, { index: 1, path: 'b.txt', ctrlKey: true, shiftKey: false }, ENTRIES);
    expect(next.selected).toEqual(new Set(['b.txt']));

    const next2 = nextSelection(next, { index: 3, path: 'd.txt', ctrlKey: true, shiftKey: false }, ENTRIES);
    expect(next2.selected).toEqual(new Set(['b.txt', 'd.txt']));
  });

  it('Ctrl クリックはトグルする（既に選択済みなら外す）', () => {
    const state: SelectionState = { selected: new Set(['a.txt', 'b.txt']), anchorIndex: 1 };
    const next = nextSelection(state, { index: 0, path: 'a.txt', ctrlKey: true, shiftKey: false }, ENTRIES);
    expect(next.selected).toEqual(new Set(['b.txt']));
  });

  it('Shift クリックはアンカーからの範囲を選択する（アンカーは変えない）', () => {
    const anchored = nextSelection(EMPTY_SELECTION, { index: 1, path: 'b.txt', ctrlKey: false, shiftKey: false }, ENTRIES);
    const ranged = nextSelection(anchored, { index: 3, path: 'd.txt', ctrlKey: false, shiftKey: true }, ENTRIES);
    expect(ranged.selected).toEqual(new Set(['b.txt', 'c.txt', 'd.txt']));
    expect(ranged.anchorIndex).toBe(1);

    // 続けて Shift+クリックしてもアンカー(1)は変わらず、範囲だけ縮む
    const shrunk = nextSelection(ranged, { index: 2, path: 'c.txt', ctrlKey: false, shiftKey: true }, ENTRIES);
    expect(shrunk.selected).toEqual(new Set(['b.txt', 'c.txt']));
    expect(shrunk.anchorIndex).toBe(1);
  });

  it('Shift クリックで未ロードの行（undefined）は範囲から除外する', () => {
    const partial: (FileEntryDto | undefined)[] = [entry('a.txt'), undefined, entry('c.txt')];
    const anchored = nextSelection(EMPTY_SELECTION, { index: 0, path: 'a.txt', ctrlKey: false, shiftKey: false }, partial);
    const ranged = nextSelection(anchored, { index: 2, path: 'c.txt', ctrlKey: false, shiftKey: true }, partial);
    expect(ranged.selected).toEqual(new Set(['a.txt', 'c.txt']));
  });

  it('アンカーが無い状態での Shift クリックは単独選択になる', () => {
    const next = nextSelection(EMPTY_SELECTION, { index: 2, path: 'c.txt', ctrlKey: false, shiftKey: true }, ENTRIES);
    expect(next.selected).toEqual(new Set(['c.txt']));
    expect(next.anchorIndex).toBe(2);
  });
});

describe('ステージ後に選ぶファイル', () => {
  it('1 行下を返す', () => {
    expect(nextSelectionAfterRemoval(ENTRIES, ['b.txt'])).toBe('c.txt');
  });

  it('一番下なら 1 行上を返す', () => {
    expect(nextSelectionAfterRemoval(ENTRIES, ['e.txt'])).toBe('d.txt');
  });

  it('複数消えるときは一番下の次を返す', () => {
    expect(nextSelectionAfterRemoval(ENTRIES, ['b.txt', 'c.txt', 'd.txt'])).toBe('e.txt');
  });

  it('複数消えて下が無ければ一番上の前を返す', () => {
    expect(nextSelectionAfterRemoval(ENTRIES, ['c.txt', 'd.txt', 'e.txt'])).toBe('b.txt');
  });

  it('全部消えるなら null', () => {
    const all = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];
    expect(nextSelectionAfterRemoval(ENTRIES, all)).toBeNull();
  });

  it('一覧に無いパスなら null（何も動かさない）', () => {
    expect(nextSelectionAfterRemoval(ENTRIES, ['zzz.txt'])).toBeNull();
  });

  it('未ロードの穴は飛ばして次を探す', () => {
    const partial: (FileEntryDto | undefined)[] = [entry('a.txt'), undefined, entry('c.txt')];
    expect(nextSelectionAfterRemoval(partial, ['a.txt'])).toBe('c.txt');
  });

  it('前後がすべて未ロードなら null（パスが分からないので選べない）', () => {
    const partial: (FileEntryDto | undefined)[] = [undefined, entry('b.txt'), undefined];
    expect(nextSelectionAfterRemoval(partial, ['b.txt'])).toBeNull();
  });
});
