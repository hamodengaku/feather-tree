/*
 * Unity モードの GameObject 単位の解消を、作業ツリーへ書き出す（画面の「適用」。2026-10-10、利用者の指示）。
 *
 * 組み立ては unity 層の純関数（`composeResolution`）。ここは I/O と照合だけを持つ:
 *
 *   1. 作業ツリーを読み直し、ビューを作ったときの指紋と照合する（食い違えば StaleDiffError）
 *   2. 選んだ側で組み立てる。選び残し・参照の欠けがあれば**何も書かずに断る**
 *   3. 作業ツリーへ書く（git は 0 プロセス）。**インデックスには触れない**
 *      ——解決済みにするのは利用者のステージ（docs/02「未マージファイルのコンフリクト表示と採用」）
 */

import { type GitContext, readWorktreeText, writeWorktreeBytes } from '@feathertree/git';
import { type ComposeProblem, composeResolution, type ConflictSide } from '@feathertree/unity';
import { ConflictUnsupportedError, StaleDiffError } from './sessionErrors.js';
import { contentHash } from './contentHash.js';
import type { UnityView } from './unityView.js';

export interface UnityResolveSource {
  context(signal?: AbortSignal): GitContext;
  track<T>(args: readonly string[], run: () => Promise<T>): Promise<T>;
}

/**
 * 書き出す。戻り値は書いた中身の指紋（「前回の書き出しと同じなら上書きの確認を出さない」に使う）。
 */
export async function resolveUnityConflict(
  source: UnityResolveSource,
  view: UnityView,
  choices: ReadonlyMap<string, ConflictSide>,
  signal?: AbortSignal,
): Promise<string> {
  const conflict = view.conflict;
  const plan = conflict?.plan ?? null;
  if (conflict === null || plan === null || view.oldFile === null || view.newFile === null) {
    throw new ConflictUnsupportedError('このファイルは GameObject 単位では解消できません。');
  }

  const ctx = source.context(signal);
  const current = await source.track(['read-worktree', view.path], () => readWorktreeText(ctx, view.path));
  const now = current === null ? null : contentHash(current.text ?? '');
  if (now !== conflict.fingerprint) throw new StaleDiffError();

  const result = composeResolution(view.oldFile, view.newFile, plan, choices);
  if (!result.ok) throw new ConflictUnsupportedError(problemMessage(view, result.problems));

  await source.track(['write-conflict', view.path], () =>
    writeWorktreeBytes(ctx, view.path, Buffer.from(result.text, 'utf8')),
  );
  return contentHash(result.text);
}

/** 書き出せない理由を、GameObject の名前で言う。 */
function problemMessage(view: UnityView, problems: readonly ComposeProblem[]): string {
  const nameOf = (id: string): string => view.nodes.find((n) => n.id === id)?.name ?? id;
  const unchosen = problems.filter((p) => p.kind === 'unchosen');
  if (unchosen.length > 0) {
    return `自分側・相手側のどちらもまだ採用していない GameObject が ${String(unchosen.length)} 件あります。`;
  }
  const names = [...new Set(problems.map((p) => nameOf(p.unit)))].slice(0, 5).map((n) => `「${n}」`);
  return (
    `${names.join('')}が参照している親・持ち主・コンポーネントが、適用結果から無くなります。` +
    '親子関係にある GameObject は同じ側を採用してください。'
  );
}
