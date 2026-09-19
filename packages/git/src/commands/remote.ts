import { commandFor } from '../execution/gitCommand.js';
import { GitCommandError } from '../execution/errors.js';
import { WRITE_PREFIX } from '../execution/gitEnvironment.js';
import { runGitText } from '../execution/spawnGit.js';
import type { GitContext } from './context.js';

/*
 * リモートとのやり取り（対応表 #22〜#25）。
 *
 * `--progress` は対応表どおり必ず付けるが、**stderr は読んでいない**。
 * 進捗の中身（Receiving objects: 45%）を出すのは未実装で、
 * 今は「何を実行中か」だけをコマンドバーに出している（docs/01-architecture.md 6 章）。
 * 進捗を出す段になったら runGitText を runGitWithProgress に差し替える。
 *
 * 認証はすべて OS に委譲する（決定 13）。GIT_TERMINAL_PROMPT=0 は全実行で効いているので、
 * 資格情報が無ければハングせず異常終了し、stderr がエラー表へ写される。
 */

/**
 * 対応表 #22: 指定したリモートを取得する。追跡ブランチだけが動き、作業ツリーは触らない。
 *
 * `remote` の直前に `--` を置く（3-A）。`.git/config` の `[remote "--upload-pack=..."]` のように
 * リモート名は git のリファレンス名検証を通らない文字列にできるため、`--` が無いと
 * `--upload-pack=<任意コマンド>` をオプションとして解釈させられる（RCE）。main 側の一覧照合
 * （knownRemote）と多重防御にする。
 */
export async function fetchRemote(ctx: GitContext, remote: string): Promise<void> {
  const { exit } = await runGitText(
    commandFor(ctx, [...WRITE_PREFIX, 'fetch', '--progress', '--', remote]),
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['fetch'], exit.code, exit.stderr);
}

/**
 * 対応表 #23: 現在のブランチを上流から取り込む。
 *
 * リモート名もブランチ名も渡さない。**どこから取るかは git の設定に委ねる**
 * （上流が無ければ git 自身がそう言って失敗する。アプリ側で先回りして判定しない）。
 */
export async function pullCurrent(ctx: GitContext): Promise<void> {
  const { exit } = await runGitText(
    commandFor(ctx, [...WRITE_PREFIX, 'pull', '--progress']),
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['pull'], exit.code, exit.stderr);
}

/**
 * 対応表 #24 / #25: ブランチを 1 本プッシュする。
 *
 * setUpstream が真なら #25（`--set-upstream`）。上流がまだ無いブランチに対して使い、
 * 以後 pull / push が引数なしで通るようにする。
 * 強制プッシュ（#26）はここに無い。確認ダイアログを伴うので別の関数として足すこと。
 *
 * `remote` / `branch` の直前に `--` を置く（3-A）。fetch と同じ理由で、リモート名・ブランチ名に
 * `--receive-pack=<任意コマンド>` のような文字列が来てもオプションとして解釈させない。
 * `--set-upstream` はオプションなので `--` より前に置く（`--` の後ろは全て位置引数）。
 */
export async function pushBranch(
  ctx: GitContext,
  remote: string,
  branch: string,
  setUpstream: boolean,
): Promise<void> {
  const args = setUpstream
    ? [...WRITE_PREFIX, 'push', '--progress', '--set-upstream', '--', remote, branch]
    : [...WRITE_PREFIX, 'push', '--progress', '--', remote, branch];

  const { exit } = await runGitText(commandFor(ctx, args), ctx.signal);
  if (exit.code !== 0) throw new GitCommandError(['push'], exit.code, exit.stderr);
}
