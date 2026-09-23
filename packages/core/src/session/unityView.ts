/*
 * Unity モードの「1 ファイルぶんの見え方」を組み立てる（決定 32）。
 *
 * ここが git 層と unity 層を縫い合わせる唯一の場所で、次の順に進む。
 *
 *   1. 拡張子を見る（`.prefab` / `.unity` 以外はここで終わり）
 *   2. 旧側・新側の**全文**を取る（#48 と作業ツリーの直接読み）
 *   3. **apply が読み直すのと同じ条件の diff**（`getDiffForPatch`）を取る
 *   4. 全文と diff が同じものを指しているか照合する（A-2 / F-6）
 *   5. ヒエラルキーを組んで新旧を重ねる
 *
 * 表（プロパティの一覧）はここでは作らない。**利用者が選んだ 1 ノードのぶんだけ**
 * `rowsFor` で作る（決定 32 / F-1。全ノードぶん作ると 50MB のシーンで破綻する）。
 */

import { type BlobText, canBuildPatch, type FileDiff, type PatchRefusal, readBlobText, readWorktreeText } from '@feathertree/git';
import {
  buildLineIndex,
  buildRows,
  buildSideTree,
  companionRows,
  type GuidResolver,
  isUnityYaml,
  type LineIndex,
  type MergedNode,
  mergeTrees,
  parseUnityFile,
  type PropertyRow,
  selectionForRow,
  selectionForRows,
  type HunkPick,
  type UnityFile,
  verifyAlignment,
} from '@feathertree/unity';
import type { GitContext } from '@feathertree/git';

/** Unity モードが解釈できるファイル。1 か所で決める（増やすときはここだけ）。 */
const UNITY_EXTENSIONS = ['.prefab', '.unity'] as const;

export type UnityFormat =
  /** テキストの Unity YAML。展開できる。 */
  | 'yaml'
  /** バイナリシリアライズ、LFS のポインタ、壊れた先頭。「展開できません」を出す。 */
  | 'binary'
  /** `.prefab` / `.unity` ではない。「Prefab ではありません」を出す。 */
  | 'not-prefab';

/**
 * ステージができない理由。`PatchRefusal`（git 層の判定）に 2 つ足す。
 *  - `alignment` … 全文と diff が食い違う（改行変換 / LFS フィルタ。F-6）
 *  - `no-diff`   … diff が取れなかった（変更が無い、など）
 */
export type UnityRefusal = PatchRefusal | 'alignment' | 'no-diff';

export interface UnityView {
  readonly path: string;
  readonly staged: boolean;
  /** 作ったときの status の世代。これが進んだら作り直す。 */
  readonly statusSeq: number;
  readonly format: UnityFormat;
  readonly nodes: readonly MergedNode[];
  readonly stageable: boolean;
  readonly refusal: UnityRefusal | null;

  /* 以下は内部用。renderer へは渡さない（DTO には載せない）。 */
  readonly oldFile: UnityFile | null;
  readonly newFile: UnityFile | null;
  readonly lineIndex: LineIndex | null;
}

/** 表の 1 行と、それを押したときに main へ渡す座標。 */
export interface UnityRow {
  readonly row: PropertyRow;
  /** ステージできないなら null（未変更行、または理由ありでボタンを出さない）。 */
  readonly selection: readonly HunkPick[] | null;
  /** その 1 行を押すと**一緒に入ってしまう**他の変更行の数（git の粒度は行まで）。 */
  readonly alsoStages: number;
}

export function isUnityPath(path: string): boolean {
  const lower = path.toLowerCase();
  return UNITY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** ビューを組み立てるのに要るものだけ。`RepositorySession` がこれを満たす。 */
export interface UnityViewSource {
  readonly statusSeq: number;
  context(signal?: AbortSignal): GitContext;
  getDiffForPatch(path: string, staged: boolean, signal?: AbortSignal): Promise<FileDiff | null>;
  /** 実行ログに載せるための包み。ここを通らない git があると「実行ログに出ない git」ができてしまう。 */
  track<T>(args: readonly string[], run: () => Promise<T>): Promise<T>;
}

export async function buildUnityView(
  source: UnityViewSource,
  path: string,
  staged: boolean,
  signal?: AbortSignal,
  resolveGuid?: GuidResolver,
): Promise<UnityView> {
  const statusSeq = source.statusSeq;
  const base = { path, staged, statusSeq, oldFile: null, newFile: null, lineIndex: null } as const;

  if (!isUnityPath(path)) {
    return { ...base, format: 'not-prefab', nodes: [], stageable: false, refusal: null };
  }

  const ctx = source.context(signal);
  // 未ステージ: 旧 = index の blob / 新 = 作業ツリー（git 0 プロセス）
  // ステージ済み: 旧 = HEAD の blob / 新 = index の blob
  const oldBlob = await source.track(['show', path], () =>
    readBlobText(ctx, staged ? 'HEAD' : 'index', path),
  );
  const newBlob = staged
    ? await source.track(['show', path], () => readBlobText(ctx, 'index', path))
    : await source.track(['read-worktree', path], () => readWorktreeText(ctx, path));

  if (isBinary(oldBlob) || isBinary(newBlob)) {
    return { ...base, format: 'binary', nodes: [], stageable: false, refusal: 'binary' };
  }

  const oldText = oldBlob?.text ?? '';
  const newText = newBlob?.text ?? '';
  // 片側が空（新規ファイル・削除）なのは正常。**両側とも中身があるのに
  // Unity の YAML に見えない**ときだけ「展開できない」に倒す
  if (!looksUnity(oldText) || !looksUnity(newText)) {
    return { ...base, format: 'binary', nodes: [], stageable: false, refusal: 'binary' };
  }

  const oldFile = parseUnityFile(oldText);
  const newFile = parseUnityFile(newText);
  const nodes = mergeTrees(
    buildSideTree(oldFile, resolveGuid),
    buildSideTree(newFile, resolveGuid),
  );

  // 座標の出どころは apply が読み直すのと同じ diff（A-3）。
  // 取れなくても**表示は出す**——読む機能は行の対応と関係が無い（A-5）
  const diff = await source.getDiffForPatch(path, staged, signal);
  if (diff === null) {
    return { ...base, format: 'yaml', nodes, stageable: false, refusal: 'no-diff', oldFile, newFile };
  }

  const refusal = canBuildPatch(diff);
  if (refusal !== null) {
    return { ...base, format: 'yaml', nodes, stageable: false, refusal, oldFile, newFile };
  }

  // 全文と diff の照合。ここが落ちると「押した行とは別の場所が index に入る」（A-2）
  if (!verifyAlignment(oldFile, diff, 'old') || !verifyAlignment(newFile, diff, 'new')) {
    return {
      ...base,
      format: 'yaml',
      nodes,
      stageable: false,
      refusal: 'alignment',
      oldFile,
      newFile,
    };
  }

  return {
    ...base,
    format: 'yaml',
    nodes,
    stageable: true,
    refusal: null,
    oldFile,
    newFile,
    lineIndex: buildLineIndex(diff),
  };
}

/**
 * 選んだ 1 ノードの表。**ここで初めて**本体のパースとフローの分解が走る（F-1）。
 *
 * 結果は保持しない。1 ドキュメントは数十行なので毎回作ってよく、
 * 保持すると V8 の sliced string が元の 100MB を掴み続ける。
 */
export function rowsFor(view: UnityView, nodeId: string): readonly UnityRow[] {
  const oldDoc = view.oldFile?.byAnchor.get(nodeId) ?? null;
  const newDoc = view.newFile?.byAnchor.get(nodeId) ?? null;
  if (oldDoc === null && newDoc === null) return [];

  const rows = buildRows(view.oldFile, oldDoc, view.newFile, newDoc);
  const index = view.stageable ? view.lineIndex : null;

  return rows.map((row) => {
    if (index === null) return { row, selection: null, alsoStages: 0 };
    const selection = selectionForRow(index, row);
    if (selection === null) return { row, selection: null, alsoStages: 0 };
    return { row, selection, alsoStages: companionRows(index, rows, row).length };
  });
}

/** ノード 1 つぶんの選択（「コンポーネントをステージ」）。 */
export function selectionForNode(view: UnityView, nodeId: string): readonly HunkPick[] | null {
  if (!view.stageable || view.lineIndex === null) return null;
  const oldDoc = view.oldFile?.byAnchor.get(nodeId) ?? null;
  const newDoc = view.newFile?.byAnchor.get(nodeId) ?? null;
  if (oldDoc === null && newDoc === null) return null;
  return selectionForRows(view.lineIndex, buildRows(view.oldFile, oldDoc, view.newFile, newDoc));
}

function isBinary(blob: BlobText | null): boolean {
  return blob !== null && blob.text === null;
}

/** 中身が空なら「その版に無い」なので許す。あるなら Unity の YAML でなければならない。 */
function looksUnity(text: string): boolean {
  return text.length === 0 || isUnityYaml(text);
}
