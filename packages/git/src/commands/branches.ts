import { commandFor } from '../execution/gitCommand.js';
import { GitCommandError } from '../execution/errors.js';
import { READ_PREFIX, WRITE_PREFIX } from '../execution/gitEnvironment.js';
import { REF_LIST_TIMEOUT_MS, runGitText } from '../execution/spawnGit.js';
import { parseRefList } from '../parsing/refList.js';
import type { BranchRef } from '../model/types.js';
import type { GitContext } from './context.js';

const FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(committerdate:iso-strict)',
  '%(contents:subject)',
].join('%1f');

/** 対応表 #3: ローカル・リモートのブランチ一覧。 */
export async function listBranches(ctx: GitContext): Promise<BranchRef[]> {
  const { exit, stdout } = await runGitText(
    commandFor(
      ctx,
      [...READ_PREFIX, 'for-each-ref', `--format=${FORMAT}`, 'refs/heads', 'refs/remotes'],
      // 所要時間は ref 数だけで決まる。数千 ref でも数秒なので、60 秒に達したら異常。
      { timeoutMs: REF_LIST_TIMEOUT_MS },
    ),
    ctx.signal,
  );

  if (exit.code !== 0) throw new GitCommandError(['for-each-ref'], exit.code, exit.stderr);
  return parseRefList(stdout);
}

/*
 * ここから下（#12 / #14 / #35）は書き込み系なので**タイムアウトを付けない**。
 * 作業ツリーの書き換えやマージは、巨大リポジトリでは分単位でかかりうる
 * 「人が待つと決めた操作」であり、途中で打ち切ると中途半端な状態を残す。
 * 中断は利用者の明示的なキャンセル（AbortSignal）だけで行う。
 */

/**
 * 対応表 #12: ブランチ切替。
 *
 * `branchName` の直前に `--` を置く（3-B）。ref 名は `git branch -- -foo` のように
 * git 自身が正式にサポートする形で先頭 `-` を持てるため、`--` が無いと
 * `switch --discard-changes` のような未コミット変更の無警告破棄オプションを注入されうる。
 * 実測（.tmp/release-prep/f1-lab）: `switch -- <branch>` は通常の切替と同じ結果になる。
 * main 側の一覧照合（knownSwitchTarget）と多重防御にする。
 */
export async function switchBranch(ctx: GitContext, branchName: string): Promise<void> {
  const { exit } = await runGitText(
    commandFor(ctx, [...WRITE_PREFIX, 'switch', '--', branchName]),
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['switch'], exit.code, exit.stderr);
}

/**
 * 対応表 #47: リモートブランチをローカルへ取り出して切替（`<remote>/<branch>` を渡す）。
 *
 * `--track` はローカル枝の名前をリモート名を除いた部分から自分で決め、上流も張る。
 * DWIM（`switch -- <branch>` にリモート名なしの名前を渡す）でも同じことが起きるが、
 * **同名のブランチを持つリモートが 2 つあると `matched multiple (2) remote tracking branches`
 * で失敗する**（実測）。利用者はリモートペインで「どの origin の枝か」を選んでいるので、
 * その選択をそのまま git に渡す。
 *
 * `--` はリモート追跡名の直前（switch と同じ理由）。実測: `switch --track -- origin/feature/x`
 * は通常の `--track` と同じ結果になる。
 * ローカルに同名の枝が既にあると `a branch named '<name>' already exists` で失敗するので、
 * 呼び出し側（main）は一覧を見て、その場合は #12 の通常の切替を選ぶ。
 */
export async function switchToRemoteBranch(ctx: GitContext, remoteBranch: string): Promise<void> {
  const { exit } = await runGitText(
    commandFor(ctx, [...WRITE_PREFIX, 'switch', '--track', '--', remoteBranch]),
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['switch', '--track'], exit.code, exit.stderr);
}

/**
 * 対応表 #14: ブランチを作成して切替。push は行わない。
 *
 * `-c` は次のトークンを無条件にブランチ名として消費する（`-c` 自身が必須引数を取るため、
 * そこにオプション文字列の注入余地は無い）。危険なのは 2 番目の位置引数（起点）なので、
 * `--` は `startPoint` の直前に置く: `switch -c <name> -- <startPoint>`。
 * 実測: `switch -c -- <name> <startPoint>` は `--` の後を `-c` の引数として解釈できず失敗する
 * （`-c` と名前の間に `--` を割り込ませてはいけない）。
 */
export async function createBranch(ctx: GitContext, name: string, startPoint: string): Promise<void> {
  const { exit } = await runGitText(
    commandFor(ctx, [...WRITE_PREFIX, 'switch', '-c', name, '--', startPoint]),
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['switch', '-c'], exit.code, exit.stderr);
}

/**
 * 対応表 #35: 現在のブランチへ <branchName> をマージする。
 *
 * fast-forward を禁止しない（`--no-ff` を付けない）。git の既定に従う。
 * コンフリクトは exit != 0 で返るので、呼び出し側でエラーとして扱う
 * （自動 abort はしない。競合ファイルは作業ツリーに残す）。
 *
 * `branchName` の直前に `--` を置く（3-B、switch と同じ理由）。実測: `merge -- <branch>` は
 * 通常のマージと同じ結果になる。main 側の一覧照合（knownLocalBranch）と多重防御にする。
 */
export async function mergeBranch(ctx: GitContext, branchName: string): Promise<void> {
  const { exit, stdout } = await runGitText(
    commandFor(ctx, [...WRITE_PREFIX, 'merge', '--', branchName]),
    ctx.signal,
  );
  // 競合の説明は stdout に出る（stderr は空）。分類できるよう両方を渡す
  if (exit.code !== 0) throw new GitCommandError(['merge'], exit.code, exit.stderr, stdout);
}
