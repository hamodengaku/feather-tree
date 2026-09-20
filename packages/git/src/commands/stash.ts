import { commandFor } from '../execution/gitCommand.js';
import { GitCommandError } from '../execution/errors.js';
import { DIFF_EXTRA, READ_PREFIX, WRITE_PREFIX } from '../execution/gitEnvironment.js';
import { DIFF_TIMEOUT_MS, REF_LIST_TIMEOUT_MS, runGitText } from '../execution/spawnGit.js';
import { parseNameStatus } from '../parsing/log.js';
import { parseStashList } from '../parsing/stash.js';
import { parseUnifiedDiff } from '../parsing/diff.js';
import type { CommitFileChange, FileDiff, StashEntry } from '../model/types.js';
import type { DiffOptions } from './diff.js';
import type { GitContext } from './context.js';

/** 対応表 #28 のフォーマット（docs/02-git-command-map.md「stash 一覧」）。 */
const STASH_LIST_FORMAT = ['%gd', '%H', '%P', '%aI', '%gs'].join('%x1f') + '%x00';

/**
 * `stash@{n}` を**この層で組み立てる**。
 *
 * 呼び出し側（core / main）から参照の文字列を受け取らないのは、`pop` / `drop` が
 * その文字列をそのまま git に渡す＝**取り違えると不可逆**だから。整数だけを受け取り、
 * 形は 1 箇所で作る（docs/02-git-command-map.md #27〜#31「参照の渡し方」）。
 */
function stashRef(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError('stash の番号が不正です: ' + String(index));
  }
  return 'stash@{' + String(index) + '}';
}

async function runWrite(ctx: GitContext, args: readonly string[], label: readonly string[]): Promise<void> {
  const { exit } = await runGitText(commandFor(ctx, args), ctx.signal);
  if (exit.code !== 0) throw new GitCommandError(label, exit.code, exit.stderr);
}

/**
 * 対応表 #27: **ステージした差分だけ**を stash に退避する（決定 31）。
 *
 * `--staged` は「index に載っているものだけ」なので、`git add` 済みの未追跡ファイルも入る
 * （＝「追跡／未追跡を問わず」を素の git の機能だけで満たせる）。**`--include-untracked` は付けない**
 * ——あれは「未追跡を全部」であり、選んだものだけという要件と両立しない。
 *
 * **失敗しても stash だけはできていることがある。** ステージした差分と未ステージの差分が
 * 近接していると、git が退避分を作業ツリーから取り除く段（`apply --index -R`）で失敗し、
 * `Cannot remove worktree changes` で exit 1 になる。このとき stash は既に積まれている。
 * ここでは git の結果をそのまま例外にし、**取り直し（#2 / #28）は呼び出し側が失敗時にも行う**。
 *
 * メッセージは `--message=<msg>` の 1 引数で渡す（`-m <msg>` と違い、先頭が `-` でも
 * オプションとして解釈されない）。制御文字は core 側で弾いてある。
 */
export async function pushStagedStash(ctx: GitContext, message: string): Promise<void> {
  await runWrite(
    ctx,
    [...WRITE_PREFIX, 'stash', 'push', '--staged', `--message=${message}`],
    ['stash', 'push', '--staged'],
  );
}

/** 対応表 #28: stash の一覧。 */
export async function listStashes(ctx: GitContext): Promise<StashEntry[]> {
  const { exit, stdout } = await runGitText(
    commandFor(ctx, [...READ_PREFIX, 'stash', 'list', `--format=${STASH_LIST_FORMAT}`], {
      // reflog の件数で決まる。#3 for-each-ref と同じ性質なので同じ値
      timeoutMs: REF_LIST_TIMEOUT_MS,
    }),
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['stash', 'list'], exit.code, exit.stderr);
  return parseStashList(stdout);
}

/**
 * 対応表 #29 / #30: stash をブランチへ展開する。
 *
 * `drop` が真なら `pop`（展開して一覧から消す）、偽なら `apply`（展開して残す）。
 *
 * **`--index` は付けない。** 付けると「stash した時のステージ状態のまま戻る」が、
 * 実測では index に別ファイルのステージがあるだけで失敗し、しかも**失敗する前に
 * 利用者の index が reset される**（`Index was not unstashed.` と出るが、
 * ステージ済みだったものは未ステージに戻っている）。戻ってくる変更が未ステージ扱いに
 * なることを画面に明記するほうが安全（決定 31）。
 */
export async function applyStash(ctx: GitContext, index: number, drop: boolean): Promise<void> {
  const sub = drop ? 'pop' : 'apply';
  await runWrite(ctx, [...WRITE_PREFIX, 'stash', sub, stashRef(index)], ['stash', sub]);
}

/** 対応表 #31: stash を破棄（不可逆・確認必須）。 */
export async function dropStash(ctx: GitContext, index: number): Promise<void> {
  await runWrite(ctx, [...WRITE_PREFIX, 'stash', 'drop', stashRef(index)], ['stash', 'drop']);
}

/**
 * 対応表 #45: stash の変更ファイル一覧。
 *
 * **参照は生の oid で渡す**（`stash@{n}` は drop / pop のたびにずれるため）。
 * `git stash show` は stash の形をしたコミットなら oid でも受け付ける（実測）。
 *
 * `--include-untracked` を付けるのは、**外部で `-u` 付きに作られた stash** の
 * 未追跡ファイルまで一覧に出すため。このアプリが作る stash では結果は変わらない。
 *
 * 出力は `show --name-status -z`（#21）とまったく同じ形なので `parseNameStatus` を共有する。
 */
export async function getStashFiles(ctx: GitContext, oid: string): Promise<CommitFileChange[]> {
  const { exit, stdout } = await runGitText(
    commandFor(
      ctx,
      [...READ_PREFIX, 'stash', 'show', '--include-untracked', '--name-status', '-z', oid],
      { timeoutMs: DIFF_TIMEOUT_MS },
    ),
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['stash', 'show'], exit.code, exit.stderr);
  return parseNameStatus(stdout);
}

export interface StashDiffOptions extends DiffOptions {
  /**
   * 第 3 親（未追跡コミット）を相手に diff を取る。
   *
   * 外部で `-u` 付きに作られた stash の「未追跡としてだけ入っているファイル」は
   * `<oid>^ <oid>` の diff に現れない（実測）。そのときだけ呼び出し側が真で打ち直す。
   * **このアプリが作る stash（親 2 つ）では常に偽。**
   */
  readonly fromUntracked?: boolean;
}

/**
 * 対応表 #46: stash 内の 1 ファイルの diff。
 *
 * `<oid>^`（第 1 親＝ stash を作ったときの HEAD）から `<oid>`（＝退避した内容）への差分。
 * `git stash show -p <oid> -- <path>` は使えない（実測で `Too many revisions specified`。
 * `stash show` はパス指定を受け付けない）ので、素の `diff` を 2 点指定で打つ。
 *
 * 戻りは作業ツリー／コミットの diff と同じ `FileDiff`。描画側が 1 つの形だけを相手にできる。
 */
export async function getStashFileDiff(
  ctx: GitContext,
  oid: string,
  path: string,
  options: StashDiffOptions = {},
): Promise<FileDiff | null> {
  const target = options.fromUntracked === true ? `${oid}^3` : oid;
  const args = [
    ...READ_PREFIX,
    'diff',
    ...DIFF_EXTRA,
    `--unified=${options.contextLines ?? 3}`,
    `${oid}^`,
    target,
    '--',
    path,
  ];

  const { exit, stdout } = await runGitText(
    commandFor(ctx, args, { timeoutMs: DIFF_TIMEOUT_MS }),
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['diff'], exit.code, exit.stderr);

  const files = parseUnifiedDiff(
    stdout,
    options.maxLines === undefined ? {} : { maxLines: options.maxLines },
  );
  return files[0] ?? null;
}
