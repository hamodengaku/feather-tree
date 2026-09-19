import { commandFor } from '../execution/gitCommand.js';
import { GitCommandError } from '../execution/errors.js';
import { WRITE_PREFIX } from '../execution/gitEnvironment.js';
import { withPatchFile } from '../execution/pathspecFile.js';
import { runGitText } from '../execution/spawnGit.js';
import { buildHunkPatch, type HunkPick, type PatchDirection } from '../parsing/patch.js';
import type { FileDiff } from '../model/types.js';
import type { GitContext } from './context.js';

export interface ApplyHunksOptions {
  /**
   * この diff を取得したときの文脈行数。0 のときだけ `--unidiff-zero` を付ける。
   *
   * 常時付けると「文脈ゼロのハンクを不正な位置に当てる」安全弁を無意味に外すことになる。
   */
  readonly contextLines?: number;
}

/**
 * 対応表 #33 / #34: 選択された hunk / 行だけを index に適用する。
 *
 * `--cached` なので作業ツリーには触れない（＝不可逆でないため確認不要。決定 16）。
 * `--3way` / `--recount` / `--whitespace` は使わない。ヘッダの再計算は
 * parsing/patch.ts が行い、その正しさを実 git との往復テストで検証する。
 *
 * @returns パッチに載った変更行の数。
 */
export async function applyHunks(
  ctx: GitContext,
  diff: FileDiff,
  picks: readonly HunkPick[],
  direction: PatchDirection,
  options: ApplyHunksOptions = {},
): Promise<number> {
  const { patch, changedLines } = buildHunkPatch(diff, picks, direction);

  const args = [...WRITE_PREFIX, 'apply', '--cached'];
  if (direction === 'unstage') args.push('--reverse');
  if (options.contextLines === 0) args.push('--unidiff-zero');

  await withPatchFile(ctx.tempDir, patch, async (file) => {
    const { exit } = await runGitText(
      commandFor(ctx, [...args, file]),
      ctx.signal,
    );
    if (exit.code !== 0) throw new GitCommandError(['apply', '--cached'], exit.code, exit.stderr);
  });

  return changedLines;
}
