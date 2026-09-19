import { commandFor } from '../execution/gitCommand.js';
import { GitCommandError } from '../execution/errors.js';
import { READ_PREFIX } from '../execution/gitEnvironment.js';
import { runGitStream } from '../execution/spawnGit.js';
import { StatusParser } from '../parsing/statusPorcelainV2.js';
import type { StatusSnapshot } from '../model/types.js';
import type { GitContext } from './context.js';

export interface StatusOptions {
  /**
   * rename 検出を切る。巨大リポでは status の所要時間に直接効く。
   * 既定値は Phase 10 の実測で決める（docs/02-git-command-map.md rename 検出）。
   */
  readonly noRenames?: boolean;
  /** 既定は 'normal'。'all' は Unity プロジェクトで極端に遅くなるため使わない。 */
  readonly untrackedFiles?: 'no' | 'normal' | 'all';
}

/**
 * 対応表 #2: 変更一覧の取得。
 *
 * `--branch` を付けることで HEAD 情報と ahead/behind も同時に取れる。
 * このために別コマンドを打たない。
 */
export async function getStatus(ctx: GitContext, options: StatusOptions = {}): Promise<StatusSnapshot> {
  const args = [
    ...READ_PREFIX,
    'status',
    '--porcelain=v2',
    '-z',
    '--branch',
    `--untracked-files=${options.untrackedFiles ?? 'normal'}`,
  ];
  if (options.noRenames === true) args.push('--no-renames');

  const parser = new StatusParser();
  const { exit, result } = await runGitStream(
    commandFor(ctx, args),
    parser,
    ctx.signal,
  );

  if (exit.code !== 0) throw new GitCommandError(['status'], exit.code, exit.stderr);
  return result;
}
