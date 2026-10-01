/*
 * 片側（旧 or 新）の Prefab / シーンからヒエラルキーを組む（決定 32）。
 *
 * **ここが実装で最も間違えやすい。** GameObject 同士は直接つながっていない:
 *
 *   GameObject(1) ──m_Component──> Transform(4) / RectTransform(224)
 *                                     │  m_GameObject ──> 元の GameObject
 *                                     │  m_Father     ──> 親の Transform
 *                                     └  m_Children   ──> 子の Transform の並び
 *
 * つまり**親子は Transform が持っていて、順序も親の `m_Children` の並び**で決まる。
 * 「GameObject の中に親情報があるはず」と思って書くと全部作り直しになる
 * （docs/03-implementation-plan.md の F-2）。
 *
 * `PrefabInstance`(1001) だけは例外で、親は `m_Modification.m_TransformParent`。
 *
 * **stripped なドキュメント**（`--- !u!N &X stripped`）はネスト Prefab / Variant の元 Prefab に
 * 本体がある「継承した」オブジェクトの代理で、中身は `m_CorrespondingSourceObject` /
 * `m_PrefabInstance` / `m_PrefabAsset` しか持たない（`m_GameObject` も `m_Script` も無い）。
 * 親は `m_PrefabInstance` にする（2026-09-30）。以前はルートに散らばり、どの Prefab から
 * 来たものか画面から読めなかった。stripped な GameObject に**このファイルで足した**
 * コンポーネントは、自分の `m_GameObject` を辿ってその GameObject の下に入るので、
 * 「PrefabInstance ＞ 継承した GameObject ＞ 足したコンポーネント」の形になる。
 *
 * この関数は**ファイル内の全ドキュメントに走る**ので、`documentBody`（本体を全部
 * オブジェクトにする）は使わず `scanDocumentKey`（1 キーだけ引く）で済ませる。
 */

import type { UnityDocument, UnityFile, UnityValue } from '../model/types.js';
import { scanDocumentKey } from '../parse/document.js';
import { fileIdOf, guidOf, readScalar } from '../parse/read.js';

/** GameObject。 */
const CLASS_GAME_OBJECT = 1;
/** PrefabInstance（Variant・ネスト Prefab）。 */
const CLASS_PREFAB_INSTANCE = 1001;
/** Transform と RectTransform。親子関係を持つのはこの 2 つだけ。 */
const CLASS_TRANSFORM = 4;
const CLASS_RECT_TRANSFORM = 224;
/** MonoBehaviour。表示名に m_Script の guid を添える（要件 11）。 */
const CLASS_MONO_BEHAVIOUR = 114;

export type NodeKind = 'gameObject' | 'component' | 'prefabInstance';

/** 組み立て中だけ使う可変版。親と子は 2 巡目・3 巡目で埋まる。 */
interface MutableNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly classId: number;
  readonly typeName: string;
  readonly name: string;
  readonly inherited: boolean;
  readonly unresolvedScript: boolean;
  parent: string;
  readonly doc: UnityDocument;
  readonly children: string[];
}

export interface SideNode {
  /** anchor（fileID）。ノードの同一性はこれで見る。 */
  readonly id: string;
  readonly kind: NodeKind;
  readonly classId: number;
  readonly typeName: string;
  /** 画面に出す名前。 */
  readonly name: string;
  /** stripped（元 Prefab から継承した代理）か。 */
  readonly inherited: boolean;
  /** MonoBehaviour で、`m_Script` の guid がまだスクリプト名に解決できていないか。 */
  readonly unresolvedScript: boolean;
  /** 親ノードの id。ルートは空文字。 */
  readonly parent: string;
  readonly doc: UnityDocument;
  /** 子の id。GameObject では「コンポーネント群 → 子 GameObject 群」の順に並ぶ。 */
  readonly children: string[];
}

export interface SideTree {
  readonly file: UnityFile;
  readonly nodes: ReadonlyMap<string, SideNode>;
  readonly roots: readonly string[];
}

/** guid からスクリプト名 / Prefab 名を引く（要件 11。索引が無ければ常に null）。 */
export type GuidResolver = (guid: string) => string | null;

export function buildSideTree(file: UnityFile, resolveGuid?: GuidResolver): SideTree {
  const nodes = new Map<string, MutableNode>();

  // Transform の anchor <-> GameObject の anchor を相互に引けるようにする。
  // 親子を辿るときに「親の Transform → その GameObject」の変換が要るため
  const gameObjectOfTransform = new Map<string, string>();
  const transformOfGameObject = new Map<string, string>();
  /** stripped な Transform が属する PrefabInstance（ネスト Prefab の子の親を解くのに使う）。 */
  const prefabInstanceOfTransform = new Map<string, string>();

  for (const doc of file.documents) {
    if (doc.anchor === '') continue;
    if (!isTransform(doc.classId)) continue;
    const owner = fileIdOf(file, scanDocumentKey(file, doc, 'm_GameObject'));
    if (owner !== '' && owner !== '0') {
      gameObjectOfTransform.set(doc.anchor, owner);
      transformOfGameObject.set(owner, doc.anchor);
    }
    const instance = fileIdOf(file, scanDocumentKey(file, doc, 'm_PrefabInstance'));
    if (instance !== '' && instance !== '0') prefabInstanceOfTransform.set(doc.anchor, instance);
  }

  // stripped な GameObject の名前は本体（元 Prefab）にあるが、PrefabInstance で名前を
  // 上書きしていれば m_Modifications に載っている。Variant のルートはまずこれで名前が付く
  const overriddenNames = collectOverriddenNames(file);

  // 1 巡目: ノードを作る（親はまだ入れない）
  for (const doc of file.documents) {
    if (doc.anchor === '') continue;
    const kind = kindOf(doc.classId);
    const label = displayName(file, doc, kind, resolveGuid, overriddenNames);
    nodes.set(doc.anchor, {
      id: doc.anchor,
      kind,
      classId: doc.classId,
      typeName: doc.typeName,
      name: label.name,
      inherited: doc.stripped,
      unresolvedScript: label.unresolvedScript,
      parent: '',
      doc,
      children: [],
    });
  }

  // 2 巡目: 親を決める
  const parentOf = new Map<string, string>();
  for (const doc of file.documents) {
    const node = nodes.get(doc.anchor);
    if (node === undefined) continue;

    if (doc.stripped) {
      // 継承した代理は、それを持ち込んだ PrefabInstance の下に置く
      const instance = fileIdOf(file, scanDocumentKey(file, doc, 'm_PrefabInstance'));
      if (nodes.has(instance)) parentOf.set(doc.anchor, instance);
      continue;
    }

    if (node.kind === 'component') {
      // コンポーネントは、自分が指す GameObject の子になる
      const owner = fileIdOf(file, scanDocumentKey(file, doc, 'm_GameObject'));
      if (nodes.has(owner)) parentOf.set(doc.anchor, owner);
      continue;
    }

    if (node.kind === 'gameObject') {
      const transform = transformOfGameObject.get(doc.anchor);
      if (transform === undefined) continue;
      const trDoc = file.byAnchor.get(transform);
      if (trDoc === undefined) continue;
      const father = fileIdOf(file, scanDocumentKey(file, trDoc, 'm_Father'));
      const parent = resolveTransformOwner(father, gameObjectOfTransform, prefabInstanceOfTransform);
      if (parent !== '' && nodes.has(parent)) parentOf.set(doc.anchor, parent);
      continue;
    }

    // PrefabInstance の親は m_Modification.m_TransformParent
    const modification = scanDocumentKey(file, doc, 'm_Modification');
    const father = fileIdOf(file, entryIn(modification, 'm_TransformParent'));
    const parent = resolveTransformOwner(father, gameObjectOfTransform, prefabInstanceOfTransform);
    if (parent !== '' && nodes.has(parent)) parentOf.set(doc.anchor, parent);
  }

  // 3 巡目: 子を、正しい順序で並べる。
  //   GameObject の下は「m_Component の順のコンポーネント」→「m_Children の順の子」
  const componentOrder = new Map<string, number>();
  const childOrder = new Map<string, number>();
  for (const doc of file.documents) {
    const node = nodes.get(doc.anchor);
    if (node === undefined) continue;

    if (node.kind === 'gameObject') {
      const comps = scanDocumentKey(file, doc, 'm_Component');
      if (comps !== null && comps.kind === 'sequence') {
        comps.items.forEach((item, index) => {
          const id = fileIdOf(file, entryIn(item, 'component'));
          if (id !== '') componentOrder.set(id, index);
        });
      }
      const transform = transformOfGameObject.get(doc.anchor);
      const trDoc = transform === undefined ? undefined : file.byAnchor.get(transform);
      if (trDoc !== undefined) {
        const kids = scanDocumentKey(file, trDoc, 'm_Children');
        if (kids !== null && kids.kind === 'sequence') {
          kids.items.forEach((item, index) => {
            const owner = resolveTransformOwner(
              fileIdOf(file, item),
              gameObjectOfTransform,
              prefabInstanceOfTransform,
            );
            if (owner !== '') childOrder.set(owner, index);
          });
        }
      }
    }
  }

  const roots: string[] = [];
  const docOrder = new Map<string, number>();
  file.documents.forEach((doc, index) => docOrder.set(doc.anchor, index));

  for (const node of nodes.values()) {
    node.parent = parentOf.get(node.id) ?? '';
    if (node.parent === '') roots.push(node.id);
    else nodes.get(node.parent)?.children.push(node.id);
  }

  /**
   * 兄弟の並び。コンポーネントを先に、次に子。
   * 順序の出どころが無いものは**出現順**に倒す（ルートの並びには m_Children が無い）。
   */
  const rank = (id: string): number => {
    const node = nodes.get(id);
    if (node === undefined) return 0;
    if (node.kind === 'component') return componentOrder.get(id) ?? docOrder.get(id) ?? 0;
    // 子は必ずコンポーネントの後ろ。大きな下駄を履かせて混ざらないようにする
    return 1_000_000 + (childOrder.get(id) ?? docOrder.get(id) ?? 0);
  };

  for (const node of nodes.values()) {
    node.children.sort((a, b) => rank(a) - rank(b));
  }
  roots.sort((a, b) => (docOrder.get(a) ?? 0) - (docOrder.get(b) ?? 0));

  return { file, nodes, roots };
}

/* ------------------------------------------------------------------ 小物 */

function isTransform(classId: number): boolean {
  return classId === CLASS_TRANSFORM || classId === CLASS_RECT_TRANSFORM;
}

function kindOf(classId: number): NodeKind {
  if (classId === CLASS_GAME_OBJECT) return 'gameObject';
  if (classId === CLASS_PREFAB_INSTANCE) return 'prefabInstance';
  return 'component';
}

/**
 * Transform の fileID から「ヒエラルキー上の親ノード」を求める。
 *
 * 普通は その Transform の GameObject。ネスト Prefab の中を指しているときは
 * GameObject 本体がこのファイルに無いので、代わりに PrefabInstance を親にする。
 */
function resolveTransformOwner(
  transformId: string,
  gameObjectOfTransform: ReadonlyMap<string, string>,
  prefabInstanceOfTransform: ReadonlyMap<string, string>,
): string {
  if (transformId === '' || transformId === '0') return '';
  const owner = gameObjectOfTransform.get(transformId);
  if (owner !== undefined) return owner;
  return prefabInstanceOfTransform.get(transformId) ?? '';
}

/** ブロックマッピングから 1 つ引く。フローは `fileIdOf` が直接読むのでここには来ない。 */
function entryIn(value: UnityValue | null, key: string): UnityValue | null {
  if (value === null || value.kind !== 'mapping') return null;
  for (const entry of value.entries) {
    if (entry.key === key) return entry.value;
  }
  return null;
}

/**
 * PrefabInstance ごとの「名前を上書きした対象」。
 * `m_Modifications` の `propertyPath: m_Name` を拾い、`target.fileID`（元 Prefab 側の fileID）→ 名前。
 * stripped な GameObject の `m_CorrespondingSourceObject.fileID` と突き合わせて使う。
 */
function collectOverriddenNames(file: UnityFile): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const doc of file.documents) {
    if (doc.classId !== CLASS_PREFAB_INSTANCE || doc.anchor === '') continue;
    const mods = entryIn(scanDocumentKey(file, doc, 'm_Modification'), 'm_Modifications');
    if (mods === null || mods.kind !== 'sequence') continue;
    const names = new Map<string, string>();
    for (const item of mods.items) {
      const path = entryIn(item, 'propertyPath');
      if (path === null || path.kind !== 'scalar' || readScalar(file, path) !== 'm_Name') continue;
      const target = fileIdOf(file, entryIn(item, 'target'));
      const value = entryIn(item, 'value');
      if (target === '' || value === null || value.kind !== 'scalar') continue;
      const text = readScalar(file, value);
      if (text !== '') names.set(target, text);
    }
    if (names.size > 0) out.set(doc.anchor, names);
  }
  return out;
}

interface NodeLabel {
  readonly name: string;
  readonly unresolvedScript: boolean;
}

/**
 * 画面に出す名前。
 *
 * - GameObject    … `m_Name`。stripped なら PrefabInstance の名前の上書き、無ければ `GameObject`
 * - MonoBehaviour … `MonoBehaviour (guid 先頭8桁)`。索引があればスクリプト名（要件 11）
 * - PrefabInstance… `PrefabInstance (guid 先頭8桁)`。索引があれば元 Prefab 名
 * - それ以外      … クラス名そのもの（`Transform` / `MeshRenderer`）
 *
 * stripped な MonoBehaviour は `m_Script` を持たないので guid も出せない（元 Prefab を開かないと
 * スクリプトが分からない。docs/00-decisions.md 決定 32 の v2 候補「ネスト Prefab の参照先を辿る」）。
 * 継承であることは `inherited` として別に渡し、画面側で印を付ける。
 */
function displayName(
  file: UnityFile,
  doc: UnityDocument,
  kind: NodeKind,
  resolveGuid: GuidResolver | undefined,
  overriddenNames: ReadonlyMap<string, ReadonlyMap<string, string>>,
): NodeLabel {
  const plain = (name: string): NodeLabel => ({ name, unresolvedScript: false });

  if (kind === 'gameObject') {
    const name = scanDocumentKey(file, doc, 'm_Name');
    if (name !== null && name.kind === 'scalar') {
      const text = readScalar(file, name);
      if (text !== '') return plain(text);
    }
    if (doc.stripped) {
      const instance = fileIdOf(file, scanDocumentKey(file, doc, 'm_PrefabInstance'));
      const source = fileIdOf(file, scanDocumentKey(file, doc, 'm_CorrespondingSourceObject'));
      const overridden = overriddenNames.get(instance)?.get(source);
      if (overridden !== undefined) return plain(overridden);
    }
    return plain('GameObject');
  }

  if (kind === 'prefabInstance') {
    const guid = guidOf(file, scanDocumentKey(file, doc, 'm_SourcePrefab'));
    const resolved = guid === '' ? null : (resolveGuid?.(guid) ?? null);
    if (resolved !== null) return plain(resolved);
    return plain(guid === '' ? 'PrefabInstance' : 'PrefabInstance (' + guid.slice(0, 8) + ')');
  }

  if (doc.classId === CLASS_MONO_BEHAVIOUR) {
    const guid = guidOf(file, scanDocumentKey(file, doc, 'm_Script'));
    const resolved = guid === '' ? null : (resolveGuid?.(guid) ?? null);
    if (resolved !== null) return plain(resolved);
    const base = doc.typeName === '' ? 'MonoBehaviour' : doc.typeName;
    if (guid === '') return plain(base);
    return { name: base + ' (' + guid.slice(0, 8) + ')', unresolvedScript: true };
  }

  return plain(doc.typeName === '' ? 'Object ' + String(doc.classId) : doc.typeName);
}
