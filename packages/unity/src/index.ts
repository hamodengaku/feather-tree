/*
 * `@feathertree/unity` — Unity の Prefab / シーンを読んでモデルにする純関数の層（決定 32）。
 *
 * **git も Electron も Node も知らない。** テキストを入れるとモデルが出るだけで、
 * I/O も描画も持たない（`.dependency-cruiser.cjs` の `no-upward-from-unity` /
 * `no-node-in-unity` で機械的に強制している）。
 */

export type {
  ScalarStyle,
  UnityDocument,
  UnityEntry,
  UnityFile,
  UnityMapping,
  UnityScalar,
  UnitySequence,
  UnityValue,
} from './model/types.js';

export { documentBody, isUnityYaml, parseUnityFile, scanDocumentKey } from './parse/document.js';
export type { LineView } from './parse/lexer.js';
export { hasContent, indentOf, lineEnd, lineStart, lineText } from './parse/lexer.js';
export { expandFlow, scanFlowValue } from './parse/flow.js';
export { displayValue, entryOf, fileIdOf, guidOf, rawText, readScalar } from './parse/read.js';

export type { GuidResolver, NodeKind, SideNode, SideTree } from './tree/build.js';
export { buildSideTree } from './tree/build.js';
export type { MergedNode, NodeMark } from './tree/merge.js';
export { mergeTrees } from './tree/merge.js';
export type { FlatProperty } from './props/flat.js';
export type { PropertyRow, RowState } from './props/rows.js';
export { buildRows, flattenDocument } from './props/rows.js';
export type { DiffHunkLike, DiffLineLike, FileDiffLike, HunkPick, LineIndex, Side } from './map/lineMap.js';
export {
  buildLineIndex,
  companionRows,
  selectionForLines,
  selectionForRow,
  selectionForRows,
  verifyAlignment,
} from './map/lineMap.js';
