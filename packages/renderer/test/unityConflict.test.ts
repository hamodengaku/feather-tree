import { describe, expect, it } from 'vitest';
import type { UnityConflictDto } from '@feathertree/ipc';
import {
  adoptedSide,
  conflictEntryIndex,
  isConflictNode,
  unchosenCount,
  unityColumnLabels,
  writeBlocker,
  type UnitySide,
} from '../src/lib/unityConflict.js';

/* Unity モードの未マージ表示と GameObject 単位の解消（2026-10-10）。 */

const CONFLICT: UnityConflictDto = {
  ours: 'present',
  theirs: 'present',
  worktreeHasMarkers: true,
  resolvable: true,
  token: 't',
  units: ['100'],
  entries: [
    { id: '100', unit: '100', auto: null },
    { id: '101', unit: '100', auto: 'theirs' },
    { id: '300', unit: '200', auto: 'ours' },
  ],
};

const index = conflictEntryIndex(CONFLICT);
const choices = (entries: readonly (readonly [string, UnitySide])[]): ReadonlyMap<string, UnitySide> => new Map(entries);

describe('採用側', () => {
  it('選ぶ単位に属するノードは、選ぶまで決まらない（自動の側があっても単位の選択が勝つ）', () => {
    expect(adoptedSide(CONFLICT, index, choices([]), '101')).toBeNull();
    expect(adoptedSide(CONFLICT, index, choices([['100', 'ours']]), '101')).toBe('ours');
  });

  it('選ぶ単位に属さないノードは自動の側', () => {
    expect(adoptedSide(CONFLICT, index, choices([]), '300')).toBe('ours');
  });

  it('両側が同じノード・未マージでないときは決まらない', () => {
    expect(adoptedSide(CONFLICT, index, choices([['100', 'ours']]), '999')).toBeNull();
    expect(adoptedSide(null, index, choices([]), '300')).toBeNull();
  });
});

describe('書き出しの可否', () => {
  it('全部選ぶまで押せない', () => {
    expect(unchosenCount(CONFLICT, choices([]))).toBe(1);
    expect(writeBlocker(CONFLICT, choices([]))).toContain('1 件');
    expect(writeBlocker(CONFLICT, choices([['100', 'theirs']]))).toBeNull();
  });

  it('片側で削除された衝突は、GameObject 単位では解消できない', () => {
    const absent: UnityConflictDto = { ...CONFLICT, theirs: 'absent', resolvable: false, units: [], entries: [] };
    expect(writeBlocker(absent, choices([]))).toContain('相手側ではこのファイルは削除');
  });
});

describe('列見出し', () => {
  it('未マージなら 自分側 / 相手側', () => {
    expect(unityColumnLabels(null)).toEqual(['変更前', '変更後']);
    expect(unityColumnLabels(CONFLICT)[0]).toContain('自分側');
  });
});

describe('衝突そのもののノード（コンフリ色で出すもの）', () => {
  it('両側が変えたノードだけ。自動で決まった片側だけの変更・違いの無いノードは含まない', () => {
    expect(isConflictNode(CONFLICT, index, '100')).toBe(true);
    expect(isConflictNode(CONFLICT, index, '101')).toBe(false);
    expect(isConflictNode(CONFLICT, index, '999')).toBe(false);
    expect(isConflictNode(null, index, '100')).toBe(false);
  });
});
