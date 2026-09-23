import { describe, expect, it } from 'vitest';
import { buildSideTree, mergeTrees, type MergedNode, parseUnityFile } from '../src/index.js';

/*
 * 新旧ヒエラルキーの合成（Phase 12 M2 / 要件 7）。
 *
 * 規則は「新しい版を軸に、旧版にしか無いものを旧版での位置に差し込む」。
 * 親が変わったものは新しい親の下に置いて `moved`。
 */

const LF = String.fromCharCode(10);

function text(...lines: readonly string[]): string {
  return lines.join(LF);
}

const HEADER = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:'] as const;

/** GameObject 1 つと、その Transform を書き出す小道具。 */
function go(
  id: number,
  name: string,
  opts: { father?: number; children?: readonly number[]; extra?: readonly string[] } = {},
): readonly string[] {
  const tr = id + 1;
  const children = opts.children ?? [];
  return [
    '--- !u!1 &' + String(id),
    'GameObject:',
    '  m_Component:',
    '  - component: {fileID: ' + String(tr) + '}',
    ...(opts.extra ?? []),
    '  m_Name: ' + name,
    '  m_IsActive: 1',
    '--- !u!4 &' + String(tr),
    'Transform:',
    '  m_GameObject: {fileID: ' + String(id) + '}',
    '  m_Children:' + (children.length === 0 ? ' []' : ''),
    ...children.map((c) => '  - {fileID: ' + String(c + 1) + '}'),
    '  m_Father: {fileID: ' + String(opts.father === undefined ? 0 : opts.father + 1) + '}',
  ];
}

function merge(oldSrc: string, newSrc: string): readonly MergedNode[] {
  return mergeTrees(
    buildSideTree(parseUnityFile(oldSrc)),
    buildSideTree(parseUnityFile(newSrc)),
  );
}

/** 読みやすさのため「名前:印」の並びにする。 */
function shape(nodes: readonly MergedNode[]): readonly string[] {
  return nodes.map((n) => '  '.repeat(n.depth) + n.name + ':' + n.mark);
}

describe('4 つの印', () => {
  it('変更なしは same', () => {
    const src = text(...HEADER, ...go(100, 'Player'), '');
    expect(shape(merge(src, src))).toEqual(['Player:same', '  Transform:same']);
  });

  it('中身が変われば changed', () => {
    const before = text(...HEADER, ...go(100, 'Player'), '');
    const after = text(...HEADER, ...go(100, 'Hero'), '');
    expect(shape(merge(before, after))).toEqual(['Hero:changed', '  Transform:same']);
  });

  it('新側にしか無ければ added', () => {
    const before = text(...HEADER, ...go(100, 'Player', { children: [200] }), '');
    const after = text(
      ...HEADER,
      ...go(100, 'Player', { children: [200, 300] }),
      ...go(200, 'Weapon', { father: 100 }),
      ...go(300, 'Shield', { father: 100 }),
      '',
    );
    const marks = merge(before, after);
    expect(marks.find((n) => n.name === 'Shield')?.mark).toBe('added');
  });

  it('旧側にしか無ければ removed', () => {
    const before = text(
      ...HEADER,
      ...go(100, 'Player', { children: [200] }),
      ...go(200, 'Weapon', { father: 100 }),
      '',
    );
    const after = text(...HEADER, ...go(100, 'Player'), '');
    const marks = merge(before, after);
    expect(marks.find((n) => n.name === 'Weapon')?.mark).toBe('removed');
  });

  it('親が変われば moved（中身も変わっているが、移動のほうを見せる）', () => {
    const before = text(
      ...HEADER,
      ...go(100, 'Player', { children: [200, 300] }),
      ...go(200, 'Holder', { father: 100 }),
      ...go(300, 'Sword', { father: 100 }),
      '',
    );
    const after = text(
      ...HEADER,
      ...go(100, 'Player', { children: [200] }),
      ...go(200, 'Holder', { father: 100, children: [300] }),
      ...go(300, 'Sword', { father: 200 }),
      '',
    );
    const marks = merge(before, after);
    const sword = marks.find((n) => n.name === 'Sword');
    expect(sword?.mark).toBe('moved');
    // 新しい親の下にいる（Holder の子）
    const holderIndex = marks.findIndex((n) => n.name === 'Holder');
    expect(marks[marks.findIndex((n) => n.name === 'Sword')]?.parent).toBe(holderIndex);
  });

  it('移動したものは旧の親の下には出さない（1 つだけ）', () => {
    const before = text(
      ...HEADER,
      ...go(100, 'Player', { children: [200, 300] }),
      ...go(200, 'Holder', { father: 100 }),
      ...go(300, 'Sword', { father: 100 }),
      '',
    );
    const after = text(
      ...HEADER,
      ...go(100, 'Player', { children: [200] }),
      ...go(200, 'Holder', { father: 100, children: [300] }),
      ...go(300, 'Sword', { father: 200 }),
      '',
    );
    expect(merge(before, after).filter((n) => n.name === 'Sword')).toHaveLength(1);
  });
});

describe('差し込む位置（旧版での位置を保つ）', () => {
  const before = text(
    ...HEADER,
    ...go(100, 'Player', { children: [200, 300, 400] }),
    ...go(200, 'A', { father: 100 }),
    ...go(300, 'B', { father: 100 }),
    ...go(400, 'C', { father: 100 }),
    '',
  );

  it('真ん中が消えたら、生き残っている直前の兄弟の後ろに差し込む', () => {
    const after = text(
      ...HEADER,
      ...go(100, 'Player', { children: [200, 400] }),
      ...go(200, 'A', { father: 100 }),
      ...go(400, 'C', { father: 100 }),
      '',
    );
    const names = merge(before, after)
      .filter((n) => n.depth === 1 && n.kind === 'gameObject')
      .map((n) => n.name + ':' + n.mark);
    expect(names).toEqual(['A:same', 'B:removed', 'C:same']);
  });

  it('先頭が消えたら先頭に差し込む', () => {
    const after = text(
      ...HEADER,
      ...go(100, 'Player', { children: [300, 400] }),
      ...go(300, 'B', { father: 100 }),
      ...go(400, 'C', { father: 100 }),
      '',
    );
    const names = merge(before, after)
      .filter((n) => n.depth === 1 && n.kind === 'gameObject')
      .map((n) => n.name + ':' + n.mark);
    expect(names).toEqual(['A:removed', 'B:same', 'C:same']);
  });

  it('連続して消えても旧版の並びを保つ', () => {
    const after = text(...HEADER, ...go(100, 'Player', { children: [400] }), ...go(400, 'C', { father: 100 }), '');
    const names = merge(before, after)
      .filter((n) => n.depth === 1 && n.kind === 'gameObject')
      .map((n) => n.name + ':' + n.mark);
    expect(names).toEqual(['A:removed', 'B:removed', 'C:same']);
  });

  it('消えたノードの子も removed として連れてくる', () => {
    const beforeNested = text(
      ...HEADER,
      ...go(100, 'Player', { children: [200] }),
      ...go(200, 'Holder', { father: 100, children: [300] }),
      ...go(300, 'Sword', { father: 200 }),
      '',
    );
    const after = text(...HEADER, ...go(100, 'Player'), '');
    // Player 自身のドキュメント（m_Component / m_Name）は変わっていないので same。
    // 子を外したことが書かれているのは Transform の m_Children なので、印はそちらに付く
    expect(shape(merge(beforeNested, after))).toEqual([
      'Player:same',
      '  Transform:changed',
      '  Holder:removed',
      '    Transform:removed',
      '    Sword:removed',
      '      Transform:removed',
    ]);
  });

  it('その Player には hasChangedDescendant が立つ（畳まれていても気づける）', () => {
    const beforeNested = text(
      ...HEADER,
      ...go(100, 'Player', { children: [200] }),
      ...go(200, 'Holder', { father: 100 }),
      '',
    );
    const after = text(...HEADER, ...go(100, 'Player'), '');
    expect(merge(beforeNested, after)[0]?.hasChangedDescendant).toBe(true);
  });
});

describe('コンポーネントの変更', () => {
  it('コンポーネントの追加は、親 GameObject の子として added になる', () => {
    const before = text(...HEADER, ...go(100, 'Player'), '');
    const after = text(
      ...HEADER,
      ...go(100, 'Player', { extra: ['  - component: {fileID: 150}'] }),
      '--- !u!95 &150',
      'Animator:',
      '  m_GameObject: {fileID: 100}',
      '  m_Enabled: 1',
      '',
    );
    expect(shape(merge(before, after))).toEqual([
      'Player:changed',
      '  Transform:same',
      '  Animator:added',
    ]);
  });

  it('コンポーネントの中身だけ変わったら、そのコンポーネントが changed', () => {
    const base = (enabled: string): string =>
      text(
        ...HEADER,
        ...go(100, 'Player', { extra: ['  - component: {fileID: 150}'] }),
        '--- !u!95 &150',
        'Animator:',
        '  m_GameObject: {fileID: 100}',
        '  m_Enabled: ' + enabled,
        '',
      );
    expect(shape(merge(base('1'), base('0')))).toEqual([
      'Player:same',
      '  Transform:same',
      '  Animator:changed',
    ]);
  });
});

describe('hasChangedDescendant（自動展開の材料）', () => {
  const before = text(
    ...HEADER,
    ...go(100, 'Player', { children: [200] }),
    ...go(200, 'Holder', { father: 100, children: [300] }),
    ...go(300, 'Sword', { father: 200 }),
    '',
  );
  const after = text(
    ...HEADER,
    ...go(100, 'Player', { children: [200] }),
    ...go(200, 'Holder', { father: 100, children: [300] }),
    ...go(300, 'Blade', { father: 200 }),
    '',
  );

  it('変わった節までの祖先すべてに立つ', () => {
    const nodes = merge(before, after);
    const byName = new Map(nodes.map((n) => [n.name, n]));
    expect(byName.get('Blade')?.mark).toBe('changed');
    expect(byName.get('Holder')?.hasChangedDescendant).toBe(true);
    expect(byName.get('Player')?.hasChangedDescendant).toBe(true);
  });

  it('変わった当人には立たない（自分の mark で分かるため）', () => {
    const nodes = merge(before, after);
    expect(nodes.find((n) => n.name === 'Blade')?.hasChangedDescendant).toBe(false);
  });

  it('何も変わっていなければどこにも立たない', () => {
    expect(merge(before, before).some((n) => n.hasChangedDescendant)).toBe(false);
  });
});

describe('改行コードと空行', () => {
  it('CRLF と LF の違いだけでは changed にしない（F-6）', () => {
    const lf = text(...HEADER, ...go(100, 'Player'), '');
    const crlf = lf.split(LF).join(String.fromCharCode(13) + LF);
    expect(merge(lf, crlf).every((n) => n.mark === 'same')).toBe(true);
  });

  it('末尾の空行の数だけでは changed にしない', () => {
    const a = text(...HEADER, ...go(100, 'Player'), '');
    const b = text(...HEADER, ...go(100, 'Player'), '', '', '');
    expect(merge(a, b).every((n) => n.mark === 'same')).toBe(true);
  });
});

describe('壊れた入力', () => {
  it('m_Father が輪を作っていても無限に潜らない', () => {
    const cyclic = text(
      ...HEADER,
      ...go(100, 'A', { father: 200, children: [200] }),
      ...go(200, 'B', { father: 100, children: [100] }),
      '',
    );
    const nodes = merge(cyclic, cyclic);
    // 同じ id を 2 度出さない
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
  });

  it('旧側が空なら全部 added', () => {
    const after = text(...HEADER, ...go(100, 'Player'), '');
    expect(merge('', after).every((n) => n.mark === 'added')).toBe(true);
  });

  it('新側が空なら全部 removed', () => {
    const before = text(...HEADER, ...go(100, 'Player'), '');
    expect(merge(before, '').every((n) => n.mark === 'removed')).toBe(true);
  });
});
