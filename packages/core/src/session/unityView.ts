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
 * 未マージ（コンフリクト中）のファイルだけは 2〜4 を差し替え、旧 = 自分側（`:2:`）・
 * 新 = 相手側（`:3:`）を読んで比べる（`buildConflictView`）。ステージはできない。
 *
 * 表（プロパティの一覧）はここでは作らない。**利用者が選んだ 1 ノードのぶんだけ**
 * `rowsFor` で作る（決定 32 / F-1。全ノードぶん作ると 50MB のシーンで破綻する）。
 */

import {
  type BlobText,
  canBuildPatch,
  type FileDiff,
  type PatchRefusal,
  readBlobText,
  readWorktreeText,
  revisionSpec,
  type StatusSnapshot,
} from '@feathertree/git';
import {
  buildLineIndex,
  buildRows,
  buildSideTree,
  companionRows,
  type ConflictPlan,
  type GuidResolver,
  isUnityYaml,
  type LineIndex,
  type MergedNode,
  mergeTrees,
  parseUnityFile,
  planConflict,
  type PropertyRow,
  selectionForRow,
  selectionForRows,
  type HunkPick,
  type UnityFile,
  verifyAlignment,
} from '@feathertree/unity';
import type { GitContext } from '@feathertree/git';
import { contentHash } from './contentHash.js';

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
 *  - `conflict`  … 未マージ。自分側と相手側を見せているだけで、index に当てる座標が無い
 */
export type UnityRefusal = PatchRefusal | 'alignment' | 'no-diff' | 'conflict';

/**
 * 未マージのときの付帯情報。旧側 = 自分側、新側 = 相手側。
 * 削除との衝突では片方の段が欠ける（`absent`）。
 */
export interface UnityConflict {
  readonly ours: 'present' | 'absent';
  readonly theirs: 'present' | 'absent';
  /** 作業ツリーに `<<<<<<<` が残っているか（まだ解消されていない印）。作業ツリーが無ければ false。 */
  readonly worktreeHasMarkers: boolean;
  /**
   * 作業ツリーの中身が何と同じか。書き出しで上書きしてよいかの判断に使う
   * （`neither` は手で編集した可能性があるので確認を挟む）。
   */
  readonly worktree: 'ours' | 'theirs' | 'markers' | 'neither' | 'absent';
  /** 作ったときの作業ツリーの指紋（sha1）。書き出しの直前に読み直して照合する。無ければ null。 */
  readonly fingerprint: string | null;
  /**
   * GameObject 単位の解消の計画。両側とも YAML で読めたときだけ非 null
   * （片側で削除された・バイナリなら、このモードでは解消できない）。
   */
  readonly plan: ConflictPlan | null;
  /** 共通祖先（`:1:`）。両側で足したファイルなら null。 */
  readonly baseFile: UnityFile | null;
}

export interface UnityView {
  readonly path: string;
  readonly staged: boolean;
  /** 作ったときの status の世代。これが進んだら作り直す。 */
  readonly statusSeq: number;
  readonly format: UnityFormat;
  readonly nodes: readonly MergedNode[];
  readonly stageable: boolean;
  readonly refusal: UnityRefusal | null;
  /** 未マージのときだけ非 null。 */
  readonly conflict: UnityConflict | null;

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
  /** 未マージかどうかを見るための status のスナップショット（git は打たない）。 */
  readonly snapshot: StatusSnapshot | null;
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
  const base = { path, staged, statusSeq, conflict: null, oldFile: null, newFile: null, lineIndex: null } as const;

  if (!isUnityPath(path)) {
    return { ...base, format: 'not-prefab', nodes: [], stageable: false, refusal: null };
  }

  const ctx = source.context(signal);

  // 未マージは status の「変更」側にしか出ない（staged 側の一覧には載らない）
  const entry = source.snapshot?.entries.find((e) => e.path === path);
  if (!staged && entry?.kind === 'unmerged') {
    return buildConflictView(source, ctx, path, statusSeq, resolveGuid);
  }

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

/**
 * 未マージのビュー。旧 = 自分側（`:2:`）、新 = 相手側（`:3:`）。
 *
 * - stage 0 が無いので `:<path>` は読めない（読むと「無い」に倒れ、全ノードが追加に見える）
 * - 作業ツリーはマーカー入りで YAML として読めない。マーカーの有無を見るためだけに読む
 * - `git diff` は結合 diff（`diff --cc`）で座標が取れないので打たない（ステージ不可）
 */
async function buildConflictView(
  source: UnityViewSource,
  ctx: GitContext,
  path: string,
  statusSeq: number,
  resolveGuid: GuidResolver | undefined,
): Promise<UnityView> {
  const oursBlob = await source.track(['show', revisionSpec('ours') + path], () => readBlobText(ctx, 'ours', path));
  const theirsBlob = await source.track(['show', revisionSpec('theirs') + path], () => readBlobText(ctx, 'theirs', path));
  const worktree = await source.track(['read-worktree', path], () => readWorktreeText(ctx, path));

  const worktreeText = worktree?.text ?? null;
  const markers = worktreeText !== null && hasConflictMarker(worktreeText);
  const shape = {
    ours: oursBlob === null ? 'absent' : 'present',
    theirs: theirsBlob === null ? 'absent' : 'present',
    worktreeHasMarkers: markers,
    worktree: worktreeState(worktree, markers, oursBlob, theirsBlob),
    fingerprint: worktree === null ? null : contentHash(worktreeText ?? ''),
  } as const;
  const unresolved: UnityConflict = { ...shape, plan: null, baseFile: null };
  const base = { path, staged: false, statusSeq, lineIndex: null, stageable: false } as const;

  if (isBinary(oursBlob) || isBinary(theirsBlob)) {
    return { ...base, conflict: unresolved, format: 'binary', nodes: [], refusal: 'binary', oldFile: null, newFile: null };
  }
  const oldText = oursBlob?.text ?? '';
  const newText = theirsBlob?.text ?? '';
  if (!looksUnity(oldText) || !looksUnity(newText)) {
    return { ...base, conflict: unresolved, format: 'binary', nodes: [], refusal: 'binary', oldFile: null, newFile: null };
  }

  const oldFile = parseUnityFile(oldText);
  const newFile = parseUnityFile(newText);
  const nodes = mergeTrees(buildSideTree(oldFile, resolveGuid), buildSideTree(newFile, resolveGuid));

  // GameObject 単位の解消は両側がそろっているときだけ（片側で削除された衝突は、ファイルを残すか消すかの話になる）
  if (oursBlob === null || theirsBlob === null) {
    return { ...base, conflict: unresolved, format: 'yaml', nodes, refusal: 'conflict', oldFile, newFile };
  }
  const baseBlob = await source.track(['show', revisionSpec('base') + path], () => readBlobText(ctx, 'base', path));
  const baseText = baseBlob?.text ?? null;
  // 祖先が読めない（バイナリ・YAML でない）なら、祖先は無いものとして全部を衝突に倒す（取り違えるより安全）
  const baseFile = baseText !== null && isUnityYaml(baseText) ? parseUnityFile(baseText) : null;
  const plan = planConflict(baseFile, oldFile, newFile);
  return {
    ...base,
    conflict: { ...shape, plan, baseFile },
    format: 'yaml',
    nodes,
    refusal: 'conflict',
    oldFile,
    newFile,
  };
}

/**
 * 未マージビューの合言葉。renderer はこれを書き出しの要求に添え、main は今のキャッシュと照合する。
 * status の世代と作業ツリーの指紋の組なので、どちらが動いても別物になる。
 */
export function unityConflictToken(view: UnityView): string {
  return String(view.statusSeq) + ':' + (view.conflict?.fingerprint ?? '-');
}


function worktreeState(
  worktree: BlobText | null,
  markers: boolean,
  ours: BlobText | null,
  theirs: BlobText | null,
): UnityConflict['worktree'] {
  if (worktree === null) return 'absent';
  if (markers) return 'markers';
  if (worktree.text !== null && worktree.text === ours?.text) return 'ours';
  if (worktree.text !== null && worktree.text === theirs?.text) return 'theirs';
  return 'neither';
}

/**
 * 行頭の `<<<<<<< `（ちょうど 7 文字）があるか。docs/02 の規則（7 文字固定）に揃える。
 * 100MB のシーンを行に割らないよう、正規表現 1 本で見る。
 */
function hasConflictMarker(text: string): boolean {
  return /^<{7}(?!<)/m.test(text);
}

function isBinary(blob: BlobText | null): boolean {
  return blob !== null && blob.text === null;
}

/** 中身が空なら「その版に無い」なので許す。あるなら Unity の YAML でなければならない。 */
function looksUnity(text: string): boolean {
  return text.length === 0 || isUnityYaml(text);
}
