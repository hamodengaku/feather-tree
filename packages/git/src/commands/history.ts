import { GitCommandError } from '../execution/errors.js';
import { DIFF_EXTRA, READ_PREFIX } from '../execution/gitEnvironment.js';
import { runGitText } from '../execution/spawnGit.js';
import { parseLog, parseNameStatus } from '../parsing/log.js';
import type { CommitFileChange, CommitSummary } from '../model/types.js';
import type { GitContext } from './context.js';

const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%s'].join('%x1f') + '%x00';

export interface LogOptions {
  readonly maxCount?: number;
  readonly skip?: number;
  /** 既定は HEAD。 */
  readonly revision?: string;
}

/** 対応表 #20: 履歴取得（フラットなリスト）。 */
export async function getLog(ctx: GitContext, options: LogOptions = {}): Promise<CommitSummary[]> {
  const args = [
    ...READ_PREFIX,
    'log',
    `--format=${LOG_FORMAT}`,
    `--max-count=${options.maxCount ?? 200}`,
  ];
  if (options.skip !== undefined && options.skip > 0) args.push(`--skip=${options.skip}`);
  args.push(options.revision ?? 'HEAD');

  const { exit, stdout } = await runGitText({ gitPath: ctx.gitPath, cwd: ctx.cwd, args }, ctx.signal);

  // コミットが 1 つも無いリポジトリでは失敗する。空配列として扱う。
  if (exit.code !== 0) {
    if (exit.stderr.includes('does not have any commits yet') || exit.stderr.includes('unknown revision')) {
      return [];
    }
    throw new GitCommandError(['log'], exit.code, exit.stderr);
  }

  return parseLog(stdout);
}

/** 対応表 #21: コミットの変更ファイル一覧。 */
export async function getCommitFiles(ctx: GitContext, oid: string): Promise<CommitFileChange[]> {
  const { exit, stdout } = await runGitText(
    {
      gitPath: ctx.gitPath,
      cwd: ctx.cwd,
      args: [...READ_PREFIX, 'show', ...DIFF_EXTRA, '--name-status', '-z', '--format=', oid],
    },
    ctx.signal,
  );

  if (exit.code !== 0) throw new GitCommandError(['show', '--name-status'], exit.code, exit.stderr);
  return parseNameStatus(stdout);
}
