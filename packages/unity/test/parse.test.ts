import { describe, expect, it } from 'vitest';
import {
  displayValue,
  documentBody,
  expandFlow,
  entryOf,
  fileIdOf,
  guidOf,
  isUnityYaml,
  lineText,
  parseUnityFile,
  scanDocumentKey,
  readScalar,
  type UnityFile,
  type UnityScalar,
  type UnityValue,
} from '../src/index.js';

/*
 * パーサの単体テスト（Phase 12 M1）。
 *
 * **値より行番号を厚く見る。** 行番号が 1 行でもずれると、表の 1 行を
 * git の hunk / 行へ引き当てられず、パラメータ単位のステージが静かに
 * 別の場所を index へ入れてしまう（決定 32 / A-3）。
 */

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

/** 行の配列をテキストにする。`\n` を直接書かないのは CLAUDE.md「この環境の癖」4 の回避。 */
function text(...lines: readonly string[]): string {
  return lines.join(LF);
}

function crlf(...lines: readonly string[]): string {
  return lines.join(CR + LF);
}

const HEADER = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:'] as const;

/** そのキーの値（最初の 1 件）。 */
function valueAt(file: UnityFile, docIndex: number, ...path: readonly string[]): UnityValue {
  const doc = file.documents[docIndex];
  expect(doc).toBeDefined();
  if (doc === undefined) throw new Error('doc missing');
  let current: UnityValue = documentBody(file, doc);
  for (const key of path) {
    const next = entryOf(file, current, key);
    expect(next, `key not found: ${key}`).not.toBeNull();
    if (next === null) throw new Error('missing');
    current = next;
  }
  return current;
}

describe('Unity YAML かどうかの判定', () => {
  it('%YAML で始まればテキスト形式と見なす', () => {
    expect(isUnityYaml(text(...HEADER, '--- !u!1 &1', 'GameObject:'))).toBe(true);
  });

  it('BOM が付いていても見分けられる', () => {
    expect(isUnityYaml(String.fromCharCode(0xfeff) + '%YAML 1.1')).toBe(true);
  });

  it('バイナリシリアライズ（%YAML で始まらない）は弾く', () => {
    expect(isUnityYaml('UnityFS' + String.fromCharCode(0) + 'binary')).toBe(false);
  });

  it('LFS のポインタも弾く（中身がファイル本体ではない）', () => {
    expect(isUnityYaml(text('version https://git-lfs.github.com/spec/v1', 'oid sha256:abc'))).toBe(
      false,
    );
  });
});

describe('ドキュメントの頭', () => {
  const src = text(
    ...HEADER,
    '--- !u!1 &6512645022092270044',
    'GameObject:',
    '  m_Name: Player',
    '--- !u!114 &5678 stripped',
    'MonoBehaviour:',
    '  m_Enabled: 1',
    '',
  );

  it('classId・anchor・stripped・クラス名を読む', () => {
    const file = parseUnityFile(src);
    expect(file.documents).toHaveLength(2);
    expect(file.documents[0]).toMatchObject({
      classId: 1,
      anchor: '6512645022092270044',
      stripped: false,
      typeName: 'GameObject',
      startLine: 3,
    });
    expect(file.documents[1]).toMatchObject({
      classId: 114,
      anchor: '5678',
      stripped: true,
      typeName: 'MonoBehaviour',
      startLine: 6,
    });
  });

  it('anchor は文字列で持つ（64bit の fileID が number に収まらないため）', () => {
    const file = parseUnityFile(src);
    // number に入れると 6512645022092270000 に丸められる値
    expect(file.documents[0]?.anchor).toBe('6512645022092270044');
    expect(file.byAnchor.get('6512645022092270044')?.classId).toBe(1);
  });

  it('ドキュメントの終端は次の頭の 1 つ前', () => {
    const file = parseUnityFile(src);
    expect(file.documents[0]?.endLine).toBe(5);
  });
});

describe('行番号', () => {
  const src = text(
    ...HEADER,
    '--- !u!4 &100',
    'Transform:',
    '  m_GameObject: {fileID: 200}',
    '  m_LocalPosition: {x: 0, y: 1.5, z: 0}',
    '  m_Children:',
    '  - {fileID: 301}',
    '  - {fileID: 302}',
    '  m_Father: {fileID: 0}',
    '',
  );

  it('素のキーは書かれている行を指す', () => {
    const file = parseUnityFile(src);
    expect(valueAt(file, 0, 'm_GameObject').startLine).toBe(5);
    expect(valueAt(file, 0, 'm_LocalPosition').startLine).toBe(6);
    expect(valueAt(file, 0, 'm_Father').startLine).toBe(10);
  });

  it('シーケンスはキーと同じインデントに並んでも値として拾う', () => {
    const file = parseUnityFile(src);
    const children = valueAt(file, 0, 'm_Children');
    expect(children.kind).toBe('sequence');
    expect(children.startLine).toBe(8);
    expect(children.endLine).toBe(9);
    if (children.kind !== 'sequence') throw new Error('not a sequence');
    expect(children.items).toHaveLength(2);
    expect(children.items[0]?.startLine).toBe(8);
    expect(children.items[1]?.startLine).toBe(9);
  });

  it('行番号で引いた行が元のテキストと一致する（diff との突き合わせの土台）', () => {
    const file = parseUnityFile(src);
    expect(lineText(file, 1)).toBe('%YAML 1.1');
    expect(lineText(file, 6)).toBe('  m_LocalPosition: {x: 0, y: 1.5, z: 0}');
    expect(lineText(file, 10)).toBe('  m_Father: {fileID: 0}');
  });

  it('CRLF でも行番号は同じで、行の中身から CR が落ちる', () => {
    const file = parseUnityFile(
      crlf(
        ...HEADER,
        '--- !u!4 &100',
        'Transform:',
        '  m_GameObject: {fileID: 200}',
        '  m_LocalPosition: {x: 0, y: 1.5, z: 0}',
        '',
      ),
    );
    expect(valueAt(file, 0, 'm_LocalPosition').startLine).toBe(6);
    expect(lineText(file, 6)).toBe('  m_LocalPosition: {x: 0, y: 1.5, z: 0}');
    expect(lineText(file, 6).endsWith(CR)).toBe(false);
  });

  it('末尾に改行が無くても最後の行を落とさない', () => {
    const file = parseUnityFile(
      text(...HEADER, '--- !u!1 &1', 'GameObject:', '  m_IsActive: 1'),
    );
    expect(file.lineCount).toBe(5);
    expect(valueAt(file, 0, 'm_IsActive').startLine).toBe(5);
    expect(readScalar(file, asScalar(valueAt(file, 0, 'm_IsActive')))).toBe('1');
  });
});

describe('フロー（1 行に収まる値）', () => {
  const file = parseUnityFile(
    text(
      ...HEADER,
      '--- !u!4 &100',
      'Transform:',
      '  m_LocalPosition: {x: 0, y: 1.5, z: -3}',
      '  m_Children: []',
      '  m_Script: {fileID: 11500000, guid: a1b2c3d4e5f6, type: 3}',
      '',
    ),
  );

  it('パース時点では分解せずスカラのまま持つ（M1 の実測でヒープが 14 倍になったため）', () => {
    const pos = valueAt(file, 0, 'm_LocalPosition');
    expect(pos.kind).toBe('scalar');
    if (pos.kind !== 'scalar') throw new Error('not a scalar');
    expect(pos.style).toBe('flow');
  });

  it('expandFlow で開くとマッピングになる', () => {
    const pos = expandFlow(file.text, valueAt(file, 0, 'm_LocalPosition'));
    expect(pos.kind).toBe('mapping');
    if (pos.kind !== 'mapping') throw new Error('not a mapping');
    expect(pos.flow).toBe(true);
    expect(pos.entries.map((e) => e.key)).toEqual(['x', 'y', 'z']);
    expect(readScalar(file, asScalar(pos.entries[1]?.value))).toBe('1.5');
    expect(readScalar(file, asScalar(pos.entries[2]?.value))).toBe('-3');
  });

  it('フローの中身は全部が同じ行にある（1 行より細かくはステージできない）', () => {
    const pos = expandFlow(file.text, valueAt(file, 0, 'm_LocalPosition'));
    if (pos.kind !== 'mapping') throw new Error('not a mapping');
    for (const entry of pos.entries) {
      expect(entry.value.startLine).toBe(5);
      expect(entry.value.endLine).toBe(5);
    }
  });

  it('空のフローシーケンスを読む', () => {
    const children = expandFlow(file.text, valueAt(file, 0, 'm_Children'));
    expect(children.kind).toBe('sequence');
    if (children.kind !== 'sequence') throw new Error('not a sequence');
    expect(children.items).toHaveLength(0);
  });

  it('fileID は開かずに直接読む（全ノードに走るので遅延の意味が消えないように）', () => {
    expect(fileIdOf(file, valueAt(file, 0, 'm_Script'))).toBe('11500000');
    expect(guidOf(file, valueAt(file, 0, 'm_Script'))).toBe('a1b2c3d4e5f6');
  });

  it('入れ子のフローで内側の fileID を拾わない', () => {
    const nested = parseUnityFile(
      text(
        ...HEADER,
        '--- !u!114 &1',
        'MonoBehaviour:',
        '  m_Ref: {inner: {fileID: 999}, fileID: 42}',
        '',
      ),
    );
    expect(fileIdOf(nested, valueAt(nested, 0, 'm_Ref'))).toBe('42');
  });

  it('guid を取り出せる', () => {
    expect(fileIdOf(file, valueAt(file, 0, 'm_Script'))).toBe('11500000');
  });

  it('元の書き方のまま表示する（整形し直さない）', () => {
    expect(displayValue(file, valueAt(file, 0, 'm_LocalPosition'))).toBe('{x: 0, y: 1.5, z: -3}');
  });
});

describe('シーケンスのコンパクト表記（m_Modifications）', () => {
  const file = parseUnityFile(
    text(
      ...HEADER,
      '--- !u!1001 &1234',
      'PrefabInstance:',
      '  m_Modification:',
      '    serializedVersion: 3',
      '    m_TransformParent: {fileID: 0}',
      '    m_Modifications:',
      '    - target: {fileID: 111, guid: aaa, type: 3}',
      '      propertyPath: m_Name',
      '      value: Player',
      '      objectReference: {fileID: 0}',
      '    - target: {fileID: 222, guid: aaa, type: 3}',
      '      propertyPath: m_LocalScale.x',
      "      value: '1.2'",
      '      objectReference: {fileID: 0}',
      '    m_RemovedComponents: []',
      '  m_SourcePrefab: {fileID: 100100000, guid: bbb, type: 3}',
      '',
    ),
  );

  it('1 要素がマッピングになり、4 行すべてを覆う', () => {
    const mods = valueAt(file, 0, 'm_Modification', 'm_Modifications');
    expect(mods.kind).toBe('sequence');
    if (mods.kind !== 'sequence') throw new Error('not a sequence');
    expect(mods.items).toHaveLength(2);

    const first = mods.items[0];
    expect(first?.kind).toBe('mapping');
    // `- target:` の行から `objectReference:` の行まで。ここが 1 パラメータの単位になる
    expect(first?.startLine).toBe(9);
    expect(first?.endLine).toBe(12);

    const second = mods.items[1];
    expect(second?.startLine).toBe(13);
    expect(second?.endLine).toBe(16);
  });

  it('要素の中のキーを引ける', () => {
    const mods = valueAt(file, 0, 'm_Modification', 'm_Modifications');
    if (mods.kind !== 'sequence') throw new Error('not a sequence');
    const second = mods.items[1];
    expect(second).toBeDefined();
    if (second === undefined) throw new Error('missing');
    const path = entryOf(file, second, 'propertyPath');
    expect(path).not.toBeNull();
    if (path === null) throw new Error('missing');
    expect(readScalar(file, asScalar(path))).toBe('m_LocalScale.x');
    expect(readScalar(file, asScalar(entryOf(file, second, 'value')))).toBe('1.2');
  });

  it('コンパクト表記の後ろに続く兄弟キーへ正しく戻る', () => {
    const removed = valueAt(file, 0, 'm_Modification', 'm_RemovedComponents');
    expect(removed.startLine).toBe(17);
    const source = valueAt(file, 0, 'm_SourcePrefab');
    expect(source.startLine).toBe(18);
  });
});

describe('スカラの書き方', () => {
  const file = parseUnityFile(
    text(
      ...HEADER,
      '--- !u!114 &1',
      'MonoBehaviour:',
      "  m_Name: 'It''s a name'",
      '  m_Quoted: "tab' + String.fromCharCode(92) + 't end"',
      '  m_Plain: 12345',
      '  m_Empty:',
      '  m_Block: |',
      '    line one',
      '    line two',
      '  m_After: 1',
      '',
    ),
  );

  it("単一引用符の '' を 1 つの ' に戻す", () => {
    expect(readScalar(file, asScalar(valueAt(file, 0, 'm_Name')))).toBe("It's a name");
  });

  it('二重引用符のエスケープを戻す', () => {
    expect(readScalar(file, asScalar(valueAt(file, 0, 'm_Quoted')))).toBe(
      'tab' + String.fromCharCode(9) + ' end',
    );
  });

  it('値が無いキーは空のスカラ', () => {
    const empty = valueAt(file, 0, 'm_Empty');
    expect(empty.kind).toBe('scalar');
    expect(readScalar(file, asScalar(empty))).toBe('');
    expect(empty.startLine).toBe(8);
  });

  it('ブロックスカラは続く行を覆い、共通インデントを剥がす', () => {
    const block = valueAt(file, 0, 'm_Block');
    expect(block.startLine).toBe(9);
    expect(block.endLine).toBe(11);
    expect(readScalar(file, asScalar(block))).toBe(text('line one', 'line two'));
  });

  it('ブロックスカラの後ろの兄弟キーへ正しく戻る', () => {
    expect(valueAt(file, 0, 'm_After').startLine).toBe(12);
  });
});

describe('壊れた入力・変わった入力', () => {
  it('重複キーを捨てずに全部持つ', () => {
    const file = parseUnityFile(
      text(...HEADER, '--- !u!1 &1', 'GameObject:', '  m_Name: first', '  m_Name: second', ''),
    );
    const doc = file.documents[0];
    if (doc === undefined) throw new Error('missing');
    expect(documentBody(file, doc).entries.map((e) => e.key)).toEqual(['m_Name', 'm_Name']);
    expect(readScalar(file, asScalar(entryOf(file, documentBody(file, doc), 'm_Name', 0)))).toBe('first');
    expect(readScalar(file, asScalar(entryOf(file, documentBody(file, doc), 'm_Name', 1)))).toBe('second');
  });

  it('インデントが 4 でも読める', () => {
    const file = parseUnityFile(
      text(
        ...HEADER,
        '--- !u!1 &1',
        'GameObject:',
        '    m_Name: Deep',
        '    m_Component:',
        '    - component: {fileID: 9}',
        '',
      ),
    );
    expect(readScalar(file, asScalar(valueAt(file, 0, 'm_Name')))).toBe('Deep');
    const comps = valueAt(file, 0, 'm_Component');
    expect(comps.kind).toBe('sequence');
    expect(comps.startLine).toBe(7);
  });

  it('値に含まれるコロンをキーの区切りと間違えない', () => {
    const file = parseUnityFile(
      text(...HEADER, '--- !u!114 &1', 'MonoBehaviour:', '  m_Url: http://example.com/a', ''),
    );
    expect(readScalar(file, asScalar(valueAt(file, 0, 'm_Url')))).toBe('http://example.com/a');
  });

  it('負の数をシーケンスの記号と間違えない', () => {
    const file = parseUnityFile(
      text(...HEADER, '--- !u!4 &1', 'Transform:', '  m_Order: -1', '  m_Next: 2', ''),
    );
    expect(readScalar(file, asScalar(valueAt(file, 0, 'm_Order')))).toBe('-1');
    expect(valueAt(file, 0, 'm_Next').startLine).toBe(6);
  });

  it('閉じていない引用符でも例外を投げず、読めたところまで返す', () => {
    const file = parseUnityFile(
      text(...HEADER, '--- !u!1 &1', 'GameObject:', "  m_Name: 'unterminated", ''),
    );
    expect(file.documents).toHaveLength(1);
    expect(valueAt(file, 0, 'm_Name').startLine).toBe(5);
  });

  it('本体が空のドキュメントでも落ちない', () => {
    const file = parseUnityFile(text(...HEADER, '--- !u!1 &1', ''));
    expect(file.documents).toHaveLength(1);
    expect(file.documents[0]?.typeName).toBe('');
    expect(file.documents[0]?.bodyStartLine).toBe(0);
  });

  it('空文字でも落ちない', () => {
    const file = parseUnityFile('');
    expect(file.documents).toHaveLength(0);
  });
});

describe('遅延パース（M1 の受け入れ条件を満たすための形）', () => {
  const file = parseUnityFile(
    text(
      ...HEADER,
      '--- !u!1 &100',
      'GameObject:',
      '  m_Component:',
      '  - component: {fileID: 200}',
      '  m_Name: Player',
      '  m_IsActive: 1',
      '--- !u!4 &200',
      'Transform:',
      '  m_GameObject: {fileID: 100}',
      '  m_Father: {fileID: 0}',
      '',
    ),
  );

  it('parseUnityFile は本体をパースせず、行の位置だけ持つ', () => {
    const doc = file.documents[0];
    expect(doc?.typeName).toBe('GameObject');
    // 本体は 5 行目（m_Component）から、インデント 2
    expect(doc?.bodyStartLine).toBe(5);
    expect(doc?.bodyIndent).toBe(2);
  });

  it('scanDocumentKey は本体を作らずに 1 キーだけ引く', () => {
    const doc = file.documents[1];
    if (doc === undefined) throw new Error('missing');
    const father = scanDocumentKey(file, doc, 'm_Father');
    expect(fileIdOf(file, father)).toBe('0');
    const go = scanDocumentKey(file, doc, 'm_GameObject');
    expect(fileIdOf(file, go)).toBe('100');
    expect(go?.startLine).toBe(11);
  });

  it('scanDocumentKey は無いキーに null を返す', () => {
    const doc = file.documents[1];
    if (doc === undefined) throw new Error('missing');
    expect(scanDocumentKey(file, doc, 'm_Name')).toBeNull();
  });

  it('scanDocumentKey は前方一致の別キーを拾わない', () => {
    const doc = file.documents[0];
    if (doc === undefined) throw new Error('missing');
    // m_Component があっても m_Comp では引けない
    expect(scanDocumentKey(file, doc, 'm_Comp')).toBeNull();
    expect(scanDocumentKey(file, doc, 'm_Component')?.kind).toBe('sequence');
  });

  it('scanDocumentKey は次のドキュメントへはみ出さない', () => {
    const doc = file.documents[0];
    if (doc === undefined) throw new Error('missing');
    // m_Father は 2 つめのドキュメントにしかない
    expect(scanDocumentKey(file, doc, 'm_Father')).toBeNull();
  });

  it('documentBody は呼ばれたときだけ本体を組み立てる', () => {
    const doc = file.documents[0];
    if (doc === undefined) throw new Error('missing');
    const body = documentBody(file, doc);
    expect(body.entries.map((e) => e.key)).toEqual(['m_Component', 'm_Name', 'm_IsActive']);
    expect(readScalar(file, asScalar(entryOf(file, body, 'm_Name')))).toBe('Player');
  });

  it('documentBody は結果を持ち回らない（毎回作り直す）', () => {
    const doc = file.documents[0];
    if (doc === undefined) throw new Error('missing');
    expect(documentBody(file, doc)).not.toBe(documentBody(file, doc));
  });
});

/** テストの見通しのための小道具。スカラでなければその場で落とす。 */
function asScalar(value: UnityValue | null | undefined): UnityScalar {
  expect(value ?? null).not.toBeNull();
  if (value === null || value === undefined) throw new Error('null value');
  expect(value.kind).toBe('scalar');
  if (value.kind !== 'scalar') throw new Error('not a scalar');
  return value;
}
