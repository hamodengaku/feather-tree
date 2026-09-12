import { describe, expect, it } from 'vitest';
import type { BranchDto } from '@feathertree/ipc';
import {
  ancestorKeys,
  buildBranchTree,
  expandKeys,
  isRepeatClick,
  isUnderPath,
  toExpandedSet,
  withCollapsed,
  withExpanded,
  type BranchTreeRow,
} from '../src/lib/branchTree.js';

function branch(shortName: string, extra: Partial<BranchDto> = {}): BranchDto {
  const isRemote = extra.isRemote ?? false;
  return {
    refName: (isRemote ? 'refs/remotes/' : 'refs/heads/') + shortName,
    shortName,
    isRemote,
    isHead: false,
    oid: '0123456789abcdef0123456789abcdef01234567',
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    committedAt: '2026-01-01T00:00:00+09:00',
    subject: '',
    ...extra,
  };
}

/** 行の並びを目で追える文字列にする。'+' は折りたたみ、'-' は展開したフォルダ。 */
function render(rows: readonly BranchTreeRow[]): string[] {
  return rows.map((row) => {
    const indent = '  '.repeat(row.depth);
    if (row.kind === 'folder') return indent + (row.expanded ? '- ' : '+ ') + row.label;
    return indent + row.label;
  });
}

const NONE: ReadonlySet<string> = new Set<string>();

describe('ブランチの階層化', () => {
  it('既定は全折りたたみで、上位フォルダだけが並ぶ', () => {
    const rows = buildBranchTree(
      [branch('main'), branch('feature/a'), branch('feature/b')],
      NONE,
      'local',
    );
    expect(render(rows)).toEqual(['+ feature', 'main']);
  });

  it('展開したフォルダの中身だけが出る', () => {
    const rows = buildBranchTree(
      [branch('main'), branch('feature/a'), branch('feature/b')],
      new Set(['local:feature']),
      'local',
    );
    expect(render(rows)).toEqual(['- feature', '  a', '  b', 'main']);
  });

  it('リモート名も第 1 階層のフォルダになる', () => {
    const rows = buildBranchTree(
      [
        branch('origin/feature/a', { isRemote: true }),
        branch('origin/main', { isRemote: true }),
        branch('upstream/main', { isRemote: true }),
      ],
      new Set(['remote:origin', 'remote:origin/feature']),
      'remote',
    );
    expect(render(rows)).toEqual(['- origin', '  - feature', '    a', '  main', '+ upstream']);
  });

  it('子が 1 つだけのフォルダは畳んで 1 行にまとめる', () => {
    const rows = buildBranchTree([branch('feature/ui/fix')], NONE, 'local');
    expect(render(rows)).toEqual(['+ feature/ui']);
    expect(rows[0]).toMatchObject({ kind: 'folder', path: 'feature/ui' });
  });

  it('まとめた行は前置きを含むキーで開ける（葉は最終セグメントのみ）', () => {
    const paths = withExpanded([], 'local', 'feature/ui');
    expect(paths).toEqual(['local:feature', 'local:feature/ui']);
    const rows = buildBranchTree([branch('feature/ui/fix')], toExpandedSet(paths), 'local');
    expect(render(rows)).toEqual(['- feature/ui', '  fix']);
  });

  it('兄弟が増えると圧縮が解け、保存済みの展開状態がそのまま効く', () => {
    const expanded = toExpandedSet(withExpanded([], 'local', 'feature/ui'));
    const rows = buildBranchTree(
      [branch('feature/ui/fix'), branch('feature/api/x')],
      expanded,
      'local',
    );
    // feature の子が 2 つになったので feature 単独の行に戻る。
    // 展開時に前置き（local:feature）も保存しているので、中まで開いたままになる。
    expect(render(rows)).toEqual(['- feature', '  + api', '  - ui', '    fix']);
  });

  it('子が葉だけのフォルダは畳まない', () => {
    const rows = buildBranchTree([branch('feature/a')], new Set(['local:feature']), 'local');
    expect(render(rows)).toEqual(['- feature', '  a']);
  });

  it('同じ階層ではフォルダが先、それぞれ名前順', () => {
    const rows = buildBranchTree(
      [branch('zeta'), branch('alpha'), branch('b/x'), branch('a/x'), branch('Main')],
      NONE,
      'local',
    );
    expect(render(rows)).toEqual(['+ a', '+ b', 'alpha', 'Main', 'zeta']);
  });

  it('ブランチの情報は葉の行にそのまま載る', () => {
    const target = branch('feature/a', { ahead: 3, behind: 1, upstream: 'origin/feature/a' });
    const rows = buildBranchTree([target, branch('feature/b')], new Set(['local:feature']), 'local');
    const leaf = rows[1];
    expect(leaf?.kind).toBe('branch');
    if (leaf?.kind === 'branch') {
      expect(leaf.label).toBe('a');
      expect(leaf.branch).toBe(target);
    }
  });
});

describe('展開キーの操作', () => {
  it('開くときは通過する前置きをすべて足し、重複はしない', () => {
    expect(expandKeys('remote', 'origin/feature/ui')).toEqual([
      'remote:origin',
      'remote:origin/feature',
      'remote:origin/feature/ui',
    ]);
    const once = withExpanded(['local:other'], 'local', 'feature/ui');
    expect(withExpanded(once, 'local', 'feature')).toEqual(once);
  });

  it('畳むときは自身と子孫だけを消す', () => {
    const keys = ['local:feature', 'local:feature/ui', 'local:featured', 'local:other'];
    expect(withCollapsed(keys, 'local', 'feature')).toEqual([
      // 'featured' は 'feature' の子孫ではない（前方一致だけで判定しない）
      'local:featured',
      'local:other',
    ]);
    expect(isUnderPath('local:feature/ui', 'local', 'feature')).toBe(true);
  });

  it('名前空間が違えば影響しない', () => {
    expect(isUnderPath('remote:feature', 'local', 'feature')).toBe(false);
  });

  it('現在のブランチの祖先だけを開く（ブランチ自身は開かない）', () => {
    expect(ancestorKeys('local', 'feature/ui/fix')).toEqual(['local:feature', 'local:feature/ui']);
    expect(ancestorKeys('local', 'main')).toEqual([]);
  });
});

describe('フォルダ行のクリック判定', () => {
  it('ダブルクリックの 2 打目以降は無視する（開いた直後に閉じないため）', () => {
    expect(isRepeatClick(2)).toBe(true);
    expect(isRepeatClick(3)).toBe(true);
  });

  it('1 打目とキーボード操作(detail 0)は通す', () => {
    expect(isRepeatClick(1)).toBe(false);
    expect(isRepeatClick(0)).toBe(false);
  });
});
