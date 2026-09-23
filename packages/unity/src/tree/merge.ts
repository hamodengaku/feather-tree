/*
 * 旧側と新側のヒエラルキーを 1 本に重ねる（決定 32 / 要件 7）。
 *
 * 合成の規則は**「新しい版を軸に、旧版にしか無いものを旧版での位置に差し込む」**。
 * 差し込む位置は「旧版で直前にいて、かつ合成後にも生き残っている兄弟の後ろ」。
 * 親が変わったものは**新しい親の下**に置いて `moved` の印を付ける
 * （旧の親の下には出さない。同じものが 2 か所に出ると数が合わなくなる）。
 *
 * 出力は**平坦な配列＋親の添字**。入れ子の JSON は IPC の構造化クローンが深さに弱く、
 * renderer の仮想リストも平坦な配列を欲しがるため（決定 32 / B-3）。
 */

import type { UnityDocument, UnityFile } from '../model/types.js';
import { indentOf, lineEnd, lineStart } from '../parse/lexer.js';
import type { NodeKind, SideTree } from './build.js';

export type NodeMark = 'same' | 'changed' | 'added' | 'removed' | 'moved';

export interface MergedNode {
  readonly id: string;
  /** 親の添字。ルートは -1。 */
  readonly parent: number;
  readonly depth: number;
  readonly kind: NodeKind;
  readonly classId: number;
  readonly name: string;
  readonly mark: NodeMark;
  /**
   * 子孫のどこかに `same` 以外が居るか。
   *
   * **main 側で計算して渡す**ことで、要件 7 の「変更のある節までの経路だけ自動展開」を
   * renderer が 1 回のなめで組み立てられる。
   */
  readonly hasChangedDescendant: boolean;
}

interface MutableNode {
  readonly id: string;
  readonly parent: number;
  readonly depth: number;
  readonly kind: NodeKind;
  readonly classId: number;
  readonly name: string;
  readonly mark: NodeMark;
  hasChangedDescendant: boolean;
}

export function mergeTrees(oldTree: SideTree, newTree: SideTree): readonly MergedNode[] {
  const out: MutableNode[] = [];
  const emitted = new Set<string>();

  /**
   * ある親の下に並ぶ子を、合成後の順序で返す。
   * `null` はルート。
   */
  const mergedChildren = (id: string | null): readonly string[] => {
    const newKids = id === null ? newTree.roots : (newTree.nodes.get(id)?.children ?? []);
    const oldKids = id === null ? oldTree.roots : (oldTree.nodes.get(id)?.children ?? []);
    if (oldKids.length === 0) return newKids;

    const result = [...newKids];
    for (let i = 0; i < oldKids.length; i += 1) {
      const kid = oldKids[i];
      if (kid === undefined) continue;
      // 新側にも居るなら、そこ（元の位置か、移動先）に出るのでここでは足さない
      if (newTree.nodes.has(kid)) continue;

      // 旧版で直前にいて、合成後にも並んでいる兄弟の後ろへ差し込む
      let at = 0;
      for (let j = i - 1; j >= 0; j -= 1) {
        const prev = oldKids[j];
        if (prev === undefined) continue;
        const pos = result.indexOf(prev);
        if (pos >= 0) {
          at = pos + 1;
          break;
        }
      }
      result.splice(at, 0, kid);
    }
    return result;
  };

  /**
   * 深さ優先で平坦化する。
   * `emitted` で同じ id を 2 度出さない——壊れたファイルの `m_Father` が輪を作っていても
   * 無限に潜らないようにするため（例外を投げるより、読めた形で出すほうがよい）。
   */
  const visit = (id: string, parent: number, depth: number): void => {
    if (emitted.has(id)) return;
    emitted.add(id);

    const index = out.length;
    out.push(makeNode(oldTree, newTree, id, parent, depth));
    for (const kid of mergedChildren(id)) visit(kid, index, depth + 1);
  };

  for (const root of mergedChildren(null)) visit(root, -1, 0);

  // 祖先へ「子孫が変わった」を伝える。DFS なので親は必ず子より前にいる
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const node = out[i];
    if (node === undefined) continue;
    if (node.mark === 'same' && !node.hasChangedDescendant) continue;
    const parent = node.parent >= 0 ? out[node.parent] : undefined;
    if (parent !== undefined) parent.hasChangedDescendant = true;
  }

  return out;
}

function makeNode(
  oldTree: SideTree,
  newTree: SideTree,
  id: string,
  parent: number,
  depth: number,
): MutableNode {
  const oldNode = oldTree.nodes.get(id);
  const newNode = newTree.nodes.get(id);
  // 名前・種別は新側を優先する（今そうなっているものを見せる）
  const shown = newNode ?? oldNode;

  let mark: NodeMark = 'same';
  if (newNode === undefined) mark = 'removed';
  else if (oldNode === undefined) mark = 'added';
  else if (oldNode.parent !== newNode.parent) mark = 'moved';
  else if (!documentEquals(oldTree.file, oldNode.doc, newTree.file, newNode.doc)) mark = 'changed';

  return {
    id,
    parent,
    depth,
    kind: shown?.kind ?? 'component',
    classId: shown?.classId ?? 0,
    name: shown?.name ?? id,
    mark,
    hasChangedDescendant: false,
  };
}

/**
 * 2 つのドキュメントの中身が同じか。
 *
 * **文字列を作らずに突き合わせる。** ノードの数だけ呼ばれるので、
 * 1 ドキュメントぶんの `slice` を 2 つ作ると 145,000 ノードで効いてくる。
 * 行末の CR は落として比べる（CRLF と LF の違いだけで「変更」にしない。F-6）。
 */
function documentEquals(
  oldFile: UnityFile,
  oldDoc: UnityDocument,
  newFile: UnityFile,
  newDoc: UnityDocument,
): boolean {
  const oldLast = lastContentLine(oldFile, oldDoc);
  const newLast = lastContentLine(newFile, newDoc);
  if (oldLast - oldDoc.startLine !== newLast - newDoc.startLine) return false;

  const count = oldLast - oldDoc.startLine;
  for (let k = 0; k <= count; k += 1) {
    const a = oldDoc.startLine + k;
    const b = newDoc.startLine + k;
    const aStart = lineStart(oldFile, a);
    const aEnd = lineEnd(oldFile, a);
    const bStart = lineStart(newFile, b);
    const bEnd = lineEnd(newFile, b);
    if (aEnd - aStart !== bEnd - bStart) return false;
    for (let i = 0; i < aEnd - aStart; i += 1) {
      if (oldFile.text.charCodeAt(aStart + i) !== newFile.text.charCodeAt(bStart + i)) return false;
    }
  }
  return true;
}

/**
 * そのドキュメントで最後に中身のある行。
 *
 * `endLine` は「次のドキュメント頭の 1 つ前」なので末尾の空行を含みうる。
 * 空行の数だけで「変更」と言わないよう、比較はここまでで打ち切る。
 */
function lastContentLine(file: UnityFile, doc: UnityDocument): number {
  for (let i = doc.endLine; i > doc.startLine; i -= 1) {
    if (indentOf(file, i) >= 0) return i;
  }
  return doc.startLine;
}
