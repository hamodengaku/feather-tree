/*
 * 未マージの Prefab / シーンを GameObject 単位で解消する（決定 32 の未マージ表示の続き）。**純関数だけ。**
 *
 * 入力は index の 3 つの段（共通祖先 `:1:` / 自分側 `:2:` / 相手側 `:3:`）。
 *
 * 1. **単位を決める**。単位は「GameObject（継承でないもの）か PrefabInstance」で、
 *    コンポーネント・継承した代理（stripped）は、ヒエラルキーで最も近い単位に属する。
 *    どの単位にも属さないもの（シーンの設定類などルートのコンポーネント）は、それ自体が単位
 * 2. **ドキュメントごとに 3-way で見る**（git と同じ規則）:
 *      - 自分側と相手側が同じ               → そのまま
 *      - 自分側が祖先と同じ（相手だけ変えた）→ 相手側
 *      - 相手側が祖先と同じ（自分だけ変えた）→ 自分側
 *      - 両方が違うように変えた             → 衝突
 *    1 つでも衝突を含む単位は、利用者に自分側か相手側かを**単位まるごと**選んでもらう
 * 3. **書き出す**。各ドキュメントを決まった側から写し、親子の参照（`m_Children`）を
 *    子の側の `m_Father` に合わせて直す。最後に参照の欠けを検査し、欠けていれば書かない
 *
 * 比較は CR を落として行う（`documentEquals`）。改行の違いだけで衝突にしない。
 */

import type { UnityDocument, UnityFile, UnityValue } from '../model/types.js';
import { parseUnityFile, scanDocumentKey } from '../parse/document.js';
import { indentOf, lineEnd, lineStart } from '../parse/lexer.js';
import { fileIdOf } from '../parse/read.js';
import { buildSideTree, type SideTree } from '../tree/build.js';
import { documentEquals } from '../tree/merge.js';

export type ConflictSide = 'ours' | 'theirs';

/**
 * 1 ドキュメントの決まり方。自分側と相手側が同じものは載せない。
 *  - `ours` / `theirs` … 片側だけが変えたので、git と同じくその側に自動で決まる
 *  - `conflict`        … 両側が変えた。属する単位を利用者が選ぶ
 */
export type DocResolution = 'ours' | 'theirs' | 'conflict';

export interface ConflictPlan {
  /** ドキュメント（anchor）→ 属する単位（anchor）。 */
  readonly unitOf: ReadonlyMap<string, string>;
  /** 自分側と相手側で違うドキュメントだけの決まり方。 */
  readonly docs: ReadonlyMap<string, DocResolution>;
  /** 利用者が選ぶ必要のある単位。ファイル内の出現順。 */
  readonly conflictUnits: readonly string[];
  /** conflictUnits を引くための集合。 */
  readonly conflictSet: ReadonlySet<string>;
}

/** 書き出しを止める理由。`anchor` はその問題を持つドキュメント、`unit` はその単位。 */
export interface ComposeProblem {
  readonly kind: 'unchosen' | 'missing-parent' | 'missing-owner' | 'missing-component';
  readonly anchor: string;
  readonly unit: string;
}

export type ComposeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly problems: readonly ComposeProblem[] };

const CLASS_GAME_OBJECT = 1;
const CLASS_PREFAB_INSTANCE = 1001;
const CLASS_TRANSFORM = 4;
const CLASS_RECT_TRANSFORM = 224;

const LF = '\n';
const CRLF = '\r\n';

export function planConflict(base: UnityFile | null, ours: UnityFile, theirs: UnityFile): ConflictPlan {
  const oursTree = buildSideTree(ours);
  const theirsTree = buildSideTree(theirs);

  const unitOf = new Map<string, string>();
  const docs = new Map<string, DocResolution>();
  const conflictUnits = new Set<string>();

  const visit = (anchor: string): void => {
    if (anchor === '' || unitOf.has(anchor)) return;
    const unit = ours.byAnchor.has(anchor) ? unitIn(oursTree, anchor) : unitIn(theirsTree, anchor);
    unitOf.set(anchor, unit);

    const o = ours.byAnchor.get(anchor);
    const t = theirs.byAnchor.get(anchor);
    if (same(ours, o, theirs, t)) return;
    // 祖先が無い（両側で足したファイル）なら、祖先は「何も無い」とみなす
    const b = base?.byAnchor.get(anchor);
    const baseFile = base ?? ours;
    let resolution: DocResolution;
    if (same(ours, o, baseFile, b)) resolution = 'theirs';
    else if (same(theirs, t, baseFile, b)) resolution = 'ours';
    else resolution = 'conflict';
    docs.set(anchor, resolution);
    if (resolution === 'conflict') conflictUnits.add(unit);
  };

  for (const doc of ours.documents) visit(doc.anchor);
  for (const doc of theirs.documents) visit(doc.anchor);

  return { unitOf, docs, conflictUnits: [...conflictUnits], conflictSet: conflictUnits };
}

/**
 * 選んだ側で 1 本のファイルを組み立てる。
 *
 * 選ばれていない衝突単位が残っていれば `unchosen` で止まる（全部選ぶまで書き出さない）。
 */
export function composeResolution(
  ours: UnityFile,
  theirs: UnityFile,
  plan: ConflictPlan,
  choices: ReadonlyMap<string, ConflictSide>,
): ComposeResult {
  const unchosen = plan.conflictUnits.filter((u) => !choices.has(u));
  if (unchosen.length > 0) {
    return { ok: false, problems: unchosen.map((u) => ({ kind: 'unchosen', anchor: u, unit: u })) };
  }

  const sideOf = (anchor: string): ConflictSide => resolvedSide(plan, choices, anchor) ?? 'ours';

  const eol = ours.text.includes(CRLF) ? CRLF : LF;
  const parts: string[] = [];
  const first = ours.documents[0];
  parts.push(first === undefined ? ours.text : ours.text.slice(0, lineStart(ours, first.startLine)));

  const emitted = new Set<string>();
  const emit = (file: UnityFile, doc: UnityDocument): void => {
    emitted.add(doc.anchor);
    let chunk = documentText(file, doc);
    if (!chunk.endsWith(LF)) chunk += eol;
    parts.push(chunk);
  };

  // 並びは自分側を軸にする。相手側にしか無いものは末尾へ（Unity は並びに意味を持たせない）
  for (const doc of ours.documents) {
    if (emitted.has(doc.anchor)) continue;
    if (sideOf(doc.anchor) === 'ours') {
      emit(ours, doc);
      continue;
    }
    const other = theirs.byAnchor.get(doc.anchor);
    if (other !== undefined) emit(theirs, other);
    else emitted.add(doc.anchor);
  }
  for (const doc of theirs.documents) {
    if (emitted.has(doc.anchor) || ours.byAnchor.has(doc.anchor)) continue;
    if (sideOf(doc.anchor) === 'theirs') emit(theirs, doc);
  }

  const composed = parseUnityFile(parts.join(''));
  const repaired = repairChildren(composed, [ours, theirs], eol);
  const problems = findProblems(parseUnityFile(repaired), [ours, theirs], plan);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, text: repaired };
}

/**
 * そのドキュメントが今の選択でどちらの側から来るか。
 *
 * 自分側と相手側が同じものは null（どちらでもない）。衝突単位でまだ選んでいなければ null。
 * 画面の「採用側の強調・棄却側の斜線」もこれで決める（書き出しと同じ規則から取る）。
 */
export function resolvedSide(
  plan: ConflictPlan,
  choices: ReadonlyMap<string, ConflictSide>,
  anchor: string,
): ConflictSide | null {
  const unit = plan.unitOf.get(anchor) ?? anchor;
  if (plan.conflictSet.has(unit)) return choices.get(unit) ?? null;
  const doc = plan.docs.get(anchor);
  return doc === 'ours' || doc === 'theirs' ? doc : null;
}

/* ------------------------------------------------------------------ 単位 */

/** 最も近い単位（継承でない GameObject か PrefabInstance）。無ければルートまで登った先。 */
function unitIn(tree: SideTree, anchor: string): string {
  let cursor = anchor;
  let last = anchor;
  // 壊れたファイルの輪で回り続けないよう、ノード数で打ち切る
  for (let guard = 0; guard <= tree.nodes.size && cursor !== ''; guard += 1) {
    const node = tree.nodes.get(cursor);
    if (node === undefined) return last;
    if ((node.kind === 'gameObject' && !node.inherited) || node.kind === 'prefabInstance') return cursor;
    last = cursor;
    cursor = node.parent;
  }
  return last;
}

function same(fa: UnityFile, a: UnityDocument | undefined, fb: UnityFile, b: UnityDocument | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return documentEquals(fa, a, fb, b);
}

/** ドキュメントの生テキスト（`---` の行から、次のドキュメントの直前まで）。 */
function documentText(file: UnityFile, doc: UnityDocument): string {
  const from = lineStart(file, doc.startLine);
  const to = doc.endLine >= file.lineCount ? file.text.length : lineStart(file, doc.endLine + 1);
  return file.text.slice(from, to);
}

/* ------------------------------------------------------------------ 親子の参照の付け直し */

function isTransform(doc: UnityDocument): boolean {
  return doc.classId === CLASS_TRANSFORM || doc.classId === CLASS_RECT_TRANSFORM;
}

function refOf(file: UnityFile, doc: UnityDocument, key: string): string {
  return fileIdOf(file, scanDocumentKey(file, doc, key));
}

/** PrefabInstance の親（`m_Modification.m_TransformParent`）。 */
function transformParentOf(file: UnityFile, doc: UnityDocument): string {
  const modification = scanDocumentKey(file, doc, 'm_Modification');
  return fileIdOf(file, entryIn(modification, 'm_TransformParent'));
}

function entryIn(value: UnityValue | null, key: string): UnityValue | null {
  if (value === null || value.kind !== 'mapping') return null;
  for (const entry of value.entries) if (entry.key === key) return entry.value;
  return null;
}

/** `m_Children` の並び。読めない形（1 行のフローに中身がある等）なら null。 */
function childrenOf(file: UnityFile, doc: UnityDocument): readonly string[] | null {
  const value = scanDocumentKey(file, doc, 'm_Children');
  if (value === null) return null;
  if (value.kind === 'sequence') return value.items.map((item) => fileIdOf(file, item));
  if (value.kind === 'scalar' && file.text.slice(value.offset, value.offset + value.length).trim() === '[]') {
    return [];
  }
  return null;
}

/**
 * 各 Transform の `m_Children` を、子の側の `m_Father`（PrefabInstance なら `m_TransformParent`）に合わせる。
 *
 * 親と子で選んだ側が違うと、親の並びに子が居ない・居ない子を指す、が起きる
 * （例: 相手側で子を足し、自分側で親の名前を変えて、親は自分側を選んだ）。
 * 子の居場所は子自身が持っている（`m_Father`）ので、そちらを正とする。
 * 並びが変わらない Transform は 1 バイトも触らない。
 */
function repairChildren(file: UnityFile, sources: readonly UnityFile[], eol: string): string {
  // PrefabInstance の根の stripped Transform は、どこかの m_Children に載っていたものだけが分かる
  const knownRoots = new Set<string>();
  for (const src of sources) {
    for (const doc of src.documents) {
      if (!isTransform(doc) || doc.stripped) continue;
      for (const id of childrenOf(src, doc) ?? []) {
        if (src.byAnchor.get(id)?.stripped === true) knownRoots.add(id);
      }
    }
  }

  const parentOf = (id: string): string | null => {
    const doc = file.byAnchor.get(id);
    if (doc === undefined) return null;
    if (doc.stripped) {
      const instance = file.byAnchor.get(refOf(file, doc, 'm_PrefabInstance'));
      return instance === undefined ? null : transformParentOf(file, instance);
    }
    if (isTransform(doc)) return refOf(file, doc, 'm_Father');
    return null;
  };

  const edits: { from: number; to: number; text: string }[] = [];
  for (const doc of file.documents) {
    if (!isTransform(doc) || doc.stripped) continue;
    const current = childrenOf(file, doc);
    if (current === null) continue;
    const next = current.filter((id) => parentOf(id) === doc.anchor);
    const kept = new Set(next);
    for (const other of file.documents) {
      if (kept.has(other.anchor) || !isTransform(other)) continue;
      if (other.stripped && !knownRoots.has(other.anchor)) continue;
      if (parentOf(other.anchor) === doc.anchor) {
        next.push(other.anchor);
        kept.add(other.anchor);
      }
    }
    if (next.length === current.length && next.every((id, i) => id === current[i])) continue;
    const edit = childrenEdit(file, doc, next, eol);
    if (edit !== null) edits.push(edit);
  }

  let text = file.text;
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
  }
  return text;
}

/** `m_Children:` の行から値の終わりまでを書き換える編集。Unity の書き方（キーと同じ深さの `- `）に揃える。 */
function childrenEdit(
  file: UnityFile,
  doc: UnityDocument,
  children: readonly string[],
  eol: string,
): { from: number; to: number; text: string } | null {
  if (doc.bodyStartLine === 0) return null;
  const indent = doc.bodyIndent;
  let keyLine = 0;
  for (let i = doc.bodyStartLine; i <= doc.endLine; i += 1) {
    if (indentOf(file, i) !== indent) continue;
    if (file.text.startsWith('m_Children:', lineStart(file, i) + indent)) {
      keyLine = i;
      break;
    }
  }
  if (keyLine === 0) return null;

  let lastLine = keyLine;
  for (let i = keyLine + 1; i <= doc.endLine; i += 1) {
    const ind = indentOf(file, i);
    if (ind < 0) break;
    const isItem = ind === indent && file.text.startsWith('- ', lineStart(file, i) + ind);
    if (ind > indent || isItem) lastLine = i;
    else break;
  }

  const pad = ' '.repeat(indent);
  const lines =
    children.length === 0
      ? [pad + 'm_Children: []']
      : [pad + 'm_Children:', ...children.map((id) => pad + '- {fileID: ' + id + '}')];
  return { from: lineStart(file, keyLine), to: lineEnd(file, lastLine), text: lines.join(eol) };
}

/* ------------------------------------------------------------------ 検査 */

/**
 * 組み立てた結果で、参照の先が無くなっていないか。
 *
 * **元の側で参照が生きていたものだけ**を問題にする。元から壊れている参照
 * （Unity が残した宙ぶらりんの fileID）で、永久に書き出せなくなるのを避けるため。
 */
function findProblems(file: UnityFile, sources: readonly UnityFile[], plan: ConflictPlan): ComposeProblem[] {
  const problems: ComposeProblem[] = [];
  const existedSomewhere = (id: string): boolean => sources.some((src) => src.byAnchor.has(id));
  const dangling = (id: string): boolean =>
    id !== '' && id !== '0' && !file.byAnchor.has(id) && existedSomewhere(id);
  const report = (kind: ComposeProblem['kind'], anchor: string): void => {
    problems.push({ kind, anchor, unit: plan.unitOf.get(anchor) ?? anchor });
  };

  for (const doc of file.documents) {
    if (doc.stripped) {
      if (dangling(refOf(file, doc, 'm_PrefabInstance'))) report('missing-owner', doc.anchor);
      continue;
    }
    if (doc.classId === CLASS_PREFAB_INSTANCE) {
      if (dangling(transformParentOf(file, doc))) report('missing-parent', doc.anchor);
      continue;
    }
    if (doc.classId === CLASS_GAME_OBJECT) {
      const comps = scanDocumentKey(file, doc, 'm_Component');
      if (comps !== null && comps.kind === 'sequence') {
        const missing = comps.items.some((item) => dangling(fileIdOf(file, entryIn(item, 'component'))));
        if (missing) report('missing-component', doc.anchor);
      }
      continue;
    }
    if (isTransform(doc) && dangling(refOf(file, doc, 'm_Father'))) {
      report('missing-parent', doc.anchor);
      continue;
    }
    if (dangling(refOf(file, doc, 'm_GameObject'))) report('missing-owner', doc.anchor);
  }
  return problems;
}
