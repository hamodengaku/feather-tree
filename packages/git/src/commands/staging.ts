import { GitCommandError } from '../execution/errors.js';
import { WRITE_PREFIX } from '../execution/gitEnvironment.js';
import { withMessageFile, withPathspecFile } from '../execution/pathspecFile.js';
import { runGitText } from '../execution/spawnGit.js';
import type { GitContext } from './context.js';

/** Windows のコマンドライン長制限を避けるため、clean に渡すパスを分割する単位。 */
const CLEAN_CHUNK = 200;

async function runWrite(ctx: GitContext, args: readonly string[], label: readonly string[]): Promise<void> {
  const { exit } = await runGitText({ gitPath: ctx.gitPath, cwd: ctx.cwd, args }, ctx.signal);
  if (exit.code !== 0) throw new GitCommandError(label, exit.code, exit.stderr);
}

/** 対応表 #5: ステージへ追加。 */
export async function stagePaths(ctx: GitContext, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  await withPathspecFile(ctx.tempDir, paths, (file) =>
    runWrite(ctx, [...WRITE_PREFIX, 'add', `--pathspec-from-file=${file}`, '--pathspec-file-nul'], ['add']),
  );
}

/** 対応表 #6: ステージから戻す。 */
export async function unstagePaths(ctx: GitContext, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  await withPathspecFile(ctx.tempDir, paths, (file) =>
    runWrite(
      ctx,
      [...WRITE_PREFIX, 'restore', '--staged', `--pathspec-from-file=${file}`, '--pathspec-file-nul'],
      ['restore', '--staged'],
    ),
  );
}

/** 対応表 #7: 作業ツリーの変更を破棄（不可逆・確認必須）。 */
export async function discardWorktree(ctx: GitContext, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  await withPathspecFile(ctx.tempDir, paths, (file) =>
    runWrite(
      ctx,
      [...WRITE_PREFIX, 'restore', '--worktree', `--pathspec-from-file=${file}`, '--pathspec-file-nul'],
      ['restore', '--worktree'],
    ),
  );
}

/** 対応表 #8: ステージ済みも含めて破棄（不可逆・確認必須）。 */
export async function discardStagedAndWorktree(ctx: GitContext, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  await withPathspecFile(ctx.tempDir, paths, (file) =>
    runWrite(
      ctx,
      [
        ...WRITE_PREFIX,
        'restore',
        '--staged',
        '--worktree',
        `--pathspec-from-file=${file}`,
        '--pathspec-file-nul',
      ],
      ['restore', '--staged', '--worktree'],
    ),
  );
}

/**
 * 対応表 #9: 未追跡ファイルを削除（不可逆・確認必須）。
 *
 * `git clean` は --pathspec-from-file に対応していないため、パスを引数で渡す。
 * コマンドライン長制限に当たらないよう分割して実行する（この 1 操作だけの例外）。
 *
 * **`git clean` はパス無しで打つとリポジトリ全体の未追跡ファイル・フォルダを無条件に全削除する**
 * （`restore --pathspec-from-file` 等と違い、空パスspecを git 自身が拒否する安全弁が無い。
 * 破壊的バグ診断で実証済み）。呼び出し元（先頭の空配列チェック / main の guardTarget）が
 * 現状は正しく効いているが、それは「今の実装がたまたま正しい」だけで、`CLEAN_CHUNK` の
 * ループ条件を変えるなどのリファクタリングで空チャンクが生成されうる形になった場合、
 * ここが最後の砦として効くようにする。多重防御であり、通常経路では発火しない。
 */
export async function removeUntracked(ctx: GitContext, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;

  for (let i = 0; i < paths.length; i += CLEAN_CHUNK) {
    const chunk = paths.slice(i, i + CLEAN_CHUNK);
    if (chunk.length === 0) {
      throw new Error('removeUntracked: empty pathspec for clean（未追跡削除の全削除事故を防ぐ防御）');
    }
    await runWrite(ctx, [...WRITE_PREFIX, 'clean', '-f', '-d', '--', ...chunk], ['clean', '-f', '-d']);
  }
}

/**
 * 対応表 #10 / #11: コミット。
 *
 * メッセージは一時ファイル経由で渡す（改行・日本語を安全に扱うため）。
 * フックは無効化しない。フックは「本物の git の挙動」の一部
 * （docs/00-decisions.md やらないこと）。
 */
export async function commit(
  ctx: GitContext,
  message: string,
  options: { readonly amend?: boolean } = {},
): Promise<string | null> {
  await withMessageFile(ctx.tempDir, message, async (file) => {
    const args = [...WRITE_PREFIX, 'commit', `--file=${file}`];
    if (options.amend === true) args.push('--amend');
    await runWrite(ctx, args, options.amend === true ? ['commit', '--amend'] : ['commit']);
  });

  const { exit, stdout } = await runGitText(
    { gitPath: ctx.gitPath, cwd: ctx.cwd, args: ['--no-pager', 'rev-parse', 'HEAD'] },
    ctx.signal,
  );
  return exit.code === 0 ? stdout.trim() : null;
}
