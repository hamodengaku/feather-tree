import { describe, expect, it } from 'vitest';
import {
  buildSideTree,
  composeResolution,
  type ConflictSide,
  parseUnityFile,
  planConflict,
  resolvedSide,
  type UnityFile,
} from '../src/index.js';

/*
 * 未マージの Prefab を GameObject 単位で解消する（決定 32 の未マージ表示の続き）。
 *
 * 見るもの:
 *   - 片側だけが変えたドキュメントは、git と同じくその側に自動で決まる
 *   - 両側が変えたものを含む GameObject だけが「選ぶ必要がある」単位になる
 *   - 単位はコンポーネントを含む（GameObject を選ぶと、そのコンポーネントも同じ側）
 *   - 親と子で選んだ側が違っても、m_Children が m_Father に合わせて直る
 *   - 選び残しがあれば書き出さない／参照の先が消えるなら書き出さない
 */

const LF = String.fromCharCode(10);
const HEADER = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:'] as const;

function text(...lines: readonly string[]): string {
  return lines.join(LF);
}

/** GameObject（id）と Transform（id + 1）。 */
function go(
  id: number,
  name: string,
  opts: { father?: number; children?: readonly number[]; scale?: string; components?: readonly number[] } = {},
): readonly string[] {
  const tr = id + 1;
  const children = opts.children ?? [];
  return [
    '--- !u!1 &' + String(id),
    'GameObject:',
    '  m_Component:',
    '  - component: {fileID: ' + String(tr) + '}',
    ...(opts.components ?? []).map((c) => '  - component: {fileID: ' + String(c) + '}'),
    '  m_Name: ' + name,
    '--- !u!4 &' + String(tr),
    'Transform:',
    '  m_GameObject: {fileID: ' + String(id) + '}',
    '  m_LocalScale: {x: ' + (opts.scale ?? '1') + ', y: 1, z: 1}',
    '  m_Children:' + (children.length === 0 ? ' []' : ''),
    ...children.map((c) => '  - {fileID: ' + String(c + 1) + '}'),
    '  m_Father: {fileID: ' + String(opts.father === undefined ? 0 : opts.father + 1) + '}',
  ];
}

function mono(id: number, owner: number, value: string): readonly string[] {
  return ['--- !u!114 &' + String(id), 'MonoBehaviour:', '  m_GameObject: {fileID: ' + String(owner) + '}', '  speed: ' + value];
}

const file = (...docs: (readonly string[])[]): UnityFile => parseUnityFile(text(...HEADER, ...docs.flat(), ''));

/** 書き出した結果を「名前（親の名前）」の並びにして見る。 */
function shape(src: string): readonly string[] {
  const tree = buildSideTree(parseUnityFile(src));
  return [...tree.nodes.values()]
    .filter((n) => n.kind === 'gameObject')
    .map((n) => n.name + '(' + (tree.nodes.get(n.parent)?.name ?? '-') + ')')
    .sort();
}

function choose(entries: readonly (readonly [string, ConflictSide])[]): ReadonlyMap<string, ConflictSide> {
  return new Map(entries);
}

describe('3-way の決まり方', () => {
  const base = file(go(100, 'Root', { children: [200] }), go(200, 'A', { father: 100 }), mono(300, 200, '1'));

  it('片側だけの変更は自動でその側、両側の変更を含む GameObject だけが衝突', () => {
    const ours = file(go(100, 'RootOurs', { children: [200] }), go(200, 'A', { father: 100 }), mono(300, 200, '1'));
    const theirs = file(go(100, 'RootTheirs', { children: [200] }), go(200, 'A', { father: 100 }), mono(300, 200, '9'));
    const plan = planConflict(base, ours, theirs);

    expect(plan.docs.get('100')).toBe('conflict');
    expect(plan.docs.get('300')).toBe('theirs');
    expect(plan.conflictUnits).toEqual(['100']);
    // コンポーネントは持ち主の GameObject の単位に入る
    expect(plan.unitOf.get('300')).toBe('200');
    expect(plan.unitOf.get('101')).toBe('100');
  });

  it('祖先が無ければ（両側で足した）、違うものはすべて衝突', () => {
    const ours = file(go(100, 'X'));
    const theirs = file(go(100, 'Y'));
    expect(planConflict(null, ours, theirs).conflictUnits).toEqual(['100']);
  });

  it('採用側は、衝突単位なら選んだ側、そうでなければ自動の側', () => {
    const ours = file(go(100, 'RootOurs', { children: [200] }), go(200, 'A', { father: 100 }), mono(300, 200, '1'));
    const theirs = file(go(100, 'RootTheirs', { children: [200] }), go(200, 'A', { father: 100 }), mono(300, 200, '9'));
    const plan = planConflict(base, ours, theirs);
    expect(resolvedSide(plan, choose([]), '100')).toBeNull();
    expect(resolvedSide(plan, choose([['100', 'theirs']]), '100')).toBe('theirs');
    // 同じ単位の Transform（変わっていない）も、選んだ側として扱う
    expect(resolvedSide(plan, choose([['100', 'theirs']]), '101')).toBe('theirs');
    expect(resolvedSide(plan, choose([]), '300')).toBe('theirs');
    expect(resolvedSide(plan, choose([]), '201')).toBeNull();
  });
});

describe('書き出し', () => {
  const base = file(go(100, 'Root', { children: [200] }), go(200, 'A', { father: 100 }), mono(300, 200, '1'));

  it('選び残しがあれば書かない', () => {
    const ours = file(go(100, 'R1', { children: [200] }), go(200, 'A', { father: 100 }), mono(300, 200, '1'));
    const theirs = file(go(100, 'R2', { children: [200] }), go(200, 'A', { father: 100 }), mono(300, 200, '1'));
    const result = composeResolution(ours, theirs, planConflict(base, ours, theirs), choose([]));
    expect(result).toEqual({ ok: false, problems: [{ kind: 'unchosen', anchor: '100', unit: '100' }] });
  });

  it('選んだ側の GameObject と、自動で決まったコンポーネントが入る', () => {
    const ours = file(go(100, 'R1', { children: [200] }), go(200, 'A', { father: 100 }), mono(300, 200, '1'));
    const theirs = file(go(100, 'R2', { children: [200] }), go(200, 'A', { father: 100 }), mono(300, 200, '9'));
    const result = composeResolution(ours, theirs, planConflict(base, ours, theirs), choose([['100', 'theirs']]));
    if (!result.ok) throw new Error('not ok');
    expect(result.text).toContain('m_Name: R2');
    expect(result.text).not.toContain('m_Name: R1');
    expect(result.text).toContain('speed: 9');
    expect(shape(result.text)).toEqual(['A(R2)', 'R2(-)']);
  });

  it('相手側で足した子は、親を自分側にしても親の m_Children に入る', () => {
    // 相手側: B を Root の下に足した（Root の Transform の m_Children も変わる）
    // 自分側: Root の名前を変えた → Root は衝突。自分側を選ぶと、自分側の m_Children には B が居ない
    const ours = file(go(100, 'RootOurs', { children: [200] }), go(200, 'A', { father: 100 }), mono(300, 200, '1'));
    const theirs = file(
      go(100, 'Root', { children: [200, 400] }),
      go(200, 'A', { father: 100 }),
      mono(300, 200, '1'),
      go(400, 'B', { father: 100 }),
    );
    const plan = planConflict(base, ours, theirs);
    expect(plan.docs.get('400')).toBe('theirs');
    const result = composeResolution(ours, theirs, plan, choose([['100', 'ours']]));
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(shape(result.text)).toEqual(['A(RootOurs)', 'B(RootOurs)', 'RootOurs(-)']);
    expect(result.text).toContain('  - {fileID: 201}' + LF + '  - {fileID: 401}');
  });

  it('相手側で消した子は、親を自分側にしても親の m_Children から外れる', () => {
    const ours = file(go(100, 'RootOurs', { children: [200] }), go(200, 'A', { father: 100 }), mono(300, 200, '1'));
    const theirs = file(go(100, 'Root'));
    const plan = planConflict(base, ours, theirs);
    // A とそのコンポーネントは相手側だけが消した → 自動で消える
    expect(plan.docs.get('200')).toBe('theirs');
    const result = composeResolution(ours, theirs, plan, choose([['100', 'ours']]));
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(shape(result.text)).toEqual(['RootOurs(-)']);
    expect(result.text).toContain('m_Children: []');
  });

  it('子の居場所が消える選び方は書かない（親を消す側を選び、子を残す側を選んだ）', () => {
    // 自分側で A を変えて A の下に C を足し、相手側で A を消した → A が衝突。
    // A を相手側（消す）にすると、自動で残る C の親が無くなる
    const ours = file(
      go(100, 'Root', { children: [200] }),
      go(200, 'A', { father: 100, children: [500], scale: '2' }),
      mono(300, 200, '1'),
      go(500, 'C', { father: 200 }),
    );
    const theirs = file(go(100, 'Root'));
    const plan = planConflict(base, ours, theirs);
    expect(plan.conflictUnits).toContain('200');
    const result = composeResolution(ours, theirs, plan, choose([['200', 'theirs']]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual({ kind: 'missing-parent', anchor: '501', unit: '500' });
  });

  it('CRLF のファイルは CRLF のまま書く', () => {
    const crlf = (f: UnityFile): UnityFile => parseUnityFile(f.text.split(LF).join('\r' + LF));
    const ours = crlf(file(go(100, 'R1', { children: [200] }), go(200, 'A', { father: 100 }), mono(300, 200, '1')));
    const theirs = crlf(
      file(go(100, 'R2', { children: [200, 400] }), go(200, 'A', { father: 100 }), mono(300, 200, '1'), go(400, 'B', { father: 100 })),
    );
    const result = composeResolution(ours, theirs, planConflict(crlf(base), ours, theirs), choose([['100', 'ours']]));
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(result.text.split('\r' + LF).length - 1).toBe(result.text.split(LF).length - 1);
    expect(shape(result.text)).toEqual(['A(R1)', 'B(R1)', 'R1(-)']);
  });
});
