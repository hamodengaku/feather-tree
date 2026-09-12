import { GitCommandError } from '../execution/errors.js';
import { DIFF_EXTRA, READ_PREFIX } from '../execution/gitEnvironment.js';
import { runGitText } from '../execution/spawnGit.js';
import { parseLog, parseNameStatus } from '../parsing/log.js';
import { parseUnifiedDiff } from '../parsing/diff.js';
import type { CommitFileChange, CommitSummary, FileDiff } from '../model/types.js';
import type { DiffOptions } from './diff.js';
import type { GitContext } from './context.js';

/** %b は改行を含むので必ず最後に置く（parseLog がそれを前提にしている）。 */
const LOG_FORMAT =
  ['%H', '%h', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s', '%b'].join('%x1f') + '%x00';

export interface LogOptions {
  readonly maxCount?: number;
  readonly skip?: number;
}

/**
 * 対応表 #20: 履歴取得。
 *
 * 範囲は **`--all` 固定**（ローカル・リモート追跡・タグのすべての先端から辿る）。
 * HEAD だけを辿るとまだマージしていないブランチの先端が 1 つも出ず、
 * グラフ（決定 20）がレーン 1 本の直線にしかならないため。
 * 件数は必ず `--max-count` で打ち切るので、ref が何百あっても所要時間は件数で決まる。
 */
export async function getLog(ctx: GitContext, options: LogOptions = {}): Promise<CommitSummary[]> {
  const args = [
    ...READ_PREFIX,
    'log',
    `--format=${LOG_FORMAT}`,
    `--max-count=${options.maxCount ?? 200}`,
  ];
  if (options.skip !== undefined && options.skip > 0) args.push(`--skip=${options.skip}`);
  args.push('--all');

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

/**
 * 対応表 #36: コミット 1 点における 1 ファイルの diff。
 *
 * #18 / #19 と同じ unified diff だが、対象が作業ツリーではなくコミットなので別の呼び出しにしてある。
 *
 * **マージコミットでは何も返らない（null）。** `git show` は `-m` / `-c` / `--cc` を付けない限り
 * 複数親のコミットの diff を出さない。これは git の既定であり、アプリ側で `-m` を足して
 * 取り繕うことはしない（決定 6 —「素の git と 1:1」）。
 */
export async function getCommitFileDiff(
  ctx: GitContext,
  oid: string,
  path: string,
  options: DiffOptions = {},
): Promise<FileDiff | null> {
  const args = [
    ...READ_PREFIX,
    'show',
    ...DIFF_EXTRA,
    `--unified=${options.contextLines ?? 3}`,
    '--format=',
    oid,
    '--',
    path,
  ];

  const { exit, stdout } = await runGitText({ gitPath: ctx.gitPath, cwd: ctx.cwd, args }, ctx.signal);
  if (exit.code !== 0) throw new GitCommandError(['show'], exit.code, exit.stderr);

  const files = parseUnifiedDiff(
    stdout,
    options.maxLines === undefined ? {} : { maxLines: options.maxLines },
  );
  return files[0] ?? null;
}
