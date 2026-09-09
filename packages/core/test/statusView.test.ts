import { describe, expect, it } from 'vitest';
import type { FileEntry, StatusSnapshot } from '@feathertree/git';
import { MAX_EXPLICIT_PATHS, filterEntries, pageEntries, resolveTarget } from '../src/index.js';

function entry(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return { kind: 'ordinary', path, staged: '.', worktree: 'M', ...over };
}

function snapshot(entries: readonly FileEntry[]): StatusSnapshot {
  return {
    head: { oid: 'abc', branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0 },
    entries,
    counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0, total: entries.length },
  };
}

const sample = snapshot([
  entry('Assets/a.png', { staged: 'M', worktree: '.' }),
  entry('Assets/b.png', { staged: '.', worktree: 'M' }),
  entry('Scripts/c.cs', { staged: 'A', worktree: 'M' }),
  entry('untracked.txt', { kind: 'untracked', staged: '.', worktree: '?' }),
  entry('conflict.txt', { kind: 'unmerged', staged: 'U', worktree: 'U' }),
]);

describe('グループ分けとフィルタ', () => {
  it('staged グループはインデックスに変化があるものだけ', () => {
    const paths = filterEntries(sample, { group: 'staged' }).map((e) => e.path);
    expect(paths).toEqual(['Assets/a.png', 'Scripts/c.cs']);
  });

  it('unstaged グループは作業ツリーに変化があるものだけ', () => {
    const paths = filterEntries(sample, { group: 'unstaged' }).map((e) => e.path);
    expect(paths).toEqual(['Assets/b.png', 'Scripts/c.cs']);
  });

  it('untracked / unmerged は種別で分かれる', () => {
    expect(filterEntries(sample, { group: 'untracked' }).map((e) => e.path)).toEqual(['untracked.txt']);
    expect(filterEntries(sample, { group: 'unmerged' }).map((e) => e.path)).toEqual(['conflict.txt']);
  });

  it('パスの部分一致は大文字小文字を無視する', () => {
    expect(filterEntries(sample, { query: 'assets/' }).map((e) => e.path)).toEqual([
      'Assets/a.png',
      'Assets/b.png',
    ]);
  });

  it('グループとクエリを併用できる', () => {
    expect(filterEntries(sample, { group: 'staged', query: 'scripts' }).map((e) => e.path)).toEqual([
      'Scripts/c.cs',
    ]);
  });
});

describe('ページング (IPC 境界)', () => {
  const many = snapshot(Array.from({ length: 10_000 }, (_, i) => entry(`f${String(i).padStart(5, '0')}.txt`)));

  it('可視範囲だけを返し、総件数は別に返す', () => {
    const page = pageEntries(many, 100, 50);
    expect(page.offset).toBe(100);
    expect(page.entries).toHaveLength(50);
    expect(page.entries[0]?.path).toBe('f00100.txt');
    expect(page.filteredTotal).toBe(10_000);
  });

  it('範囲外の offset でも壊れない', () => {
    const page = pageEntries(many, 99_999, 50);
    expect(page.entries).toHaveLength(0);
    expect(page.filteredTotal).toBe(10_000);
  });

  it('負の offset / limit を安全に扱う', () => {
    expect(pageEntries(many, -10, 5).offset).toBe(0);
    expect(pageEntries(many, 0, -5).entries).toHaveLength(0);
  });

  it('フィルタ後の総件数を返す', () => {
    const page = pageEntries(many, 0, 10, { query: 'f0000' });
    expect(page.filteredTotal).toBe(10);
    expect(page.entries).toHaveLength(10);
  });
});

describe('操作対象の解決 (パス配列を IPC に流さないための要)', () => {
  it("kind: 'all' は main 側で全パスを組み立てる", () => {
    expect(resolveTarget(sample, { kind: 'all' })).toHaveLength(5);
  });

  it("kind: 'filtered' はフィルタ結果を組み立てる", () => {
    const paths = resolveTarget(sample, { kind: 'filtered', filter: { group: 'unstaged' } });
    expect(paths).toEqual(['Assets/b.png', 'Scripts/c.cs']);
  });

  it("kind: 'paths' は明示選択をそのまま使う", () => {
    expect(resolveTarget(sample, { kind: 'paths', paths: ['x.txt'] })).toEqual(['x.txt']);
  });

  it('明示パスの上限が定義されている', () => {
    expect(MAX_EXPLICIT_PATHS).toBeGreaterThan(0);
    expect(MAX_EXPLICIT_PATHS).toBeLessThanOrEqual(10_000);
  });

  it('1 万件のスナップショットでも all を解決できる', () => {
    const many = snapshot(Array.from({ length: 10_000 }, (_, i) => entry(`f${String(i)}.txt`)));
    expect(resolveTarget(many, { kind: 'all' })).toHaveLength(10_000);
  });
});

describe("changes グループ（ステージされていない変更すべて）", () => {
  it('未ステージ・未追跡・未マージをまとめて返す', () => {
    const paths = filterEntries(sample, { group: 'changes' }).map((e) => e.path);
    expect(paths).toEqual(['Assets/b.png', 'Scripts/c.cs', 'untracked.txt', 'conflict.txt']);
  });

  it('ステージのみの変更は含まない', () => {
    const paths = filterEntries(sample, { group: 'changes' }).map((e) => e.path);
    expect(paths).not.toContain('Assets/a.png');
  });
});
