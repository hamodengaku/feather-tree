import type { ChildProcess } from 'node:child_process';

import { killTree } from './killTree.js';

/**
 * 走行中の git 子プロセスの一覧。
 *
 * これが無いと「今動いている git を全部落とす」ことができない。
 * spawnGit の run() が spawn 直後に register し、finally で unregister する
 * ので、**すべての git 実行がここを通る**（追加の操作を足しても書き忘れが起きない）。
 *
 * 唯一の用途はアプリの終了時（docs/01-architecture.md 11 章）。
 * クローン中にウィンドウを閉じると git clone が孤児として走り続け、
 * クローン先フォルダが「使用中」でエクスプローラから削除できなくなる。
 * `before-quit` で killAllGitProcesses() を呼んでから終了することで、これを防ぐ。
 *
 * 通常のキャンセル（AbortSignal → killTree）はこれを経由しない。
 * ここは「誰も個別に面倒を見られない状況」のための最後の網。
 */
const running = new Set<ChildProcess>();

/** spawn 直後に呼ぶ。戻り値を finally で呼べば解除できる。 */
export function registerGitProcess(child: ChildProcess): () => void {
  running.add(child);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running.delete(child);
  };
}

/** 走行中の git の数。終了時に「待つ必要があるか」を判断するために使う。 */
export function runningGitCount(): number {
  return running.size;
}

/**
 * 走行中の git を孫プロセスごと全件落とす。
 *
 * killTree は taskkill /T /F まで面倒を見るので、LFS のフィルタや
 * credential helper も一緒に刈れる。1 本が失敗しても残りは落とす
 * （終了処理なので、途中で投げて止まるほうが害が大きい）。
 */
export async function killAllGitProcesses(): Promise<void> {
  const targets = [...running];
  running.clear();
  await Promise.all(
    targets.map(async (child) => {
      try {
        await killTree(child);
      } catch {
        // 終了処理なので握りつぶす。落とせなかった 1 本のために残りを諦めない
      }
    }),
  );
}
