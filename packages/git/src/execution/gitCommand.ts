import type { GitContext } from '../commands/context.js';
import type { GitCommand } from './spawnGit.js';

/** コマンド 1 回ぶんの上乗せ。文脈（GitContext）では決まらないものだけを置く。 */
export interface CommandOptions {
  /**
   * コマンド固有の環境変数（`GIT_LFS_SKIP_SMUDGE` 等）。
   * **文脈の env より後に合成する**ので、同じキーならコマンド固有の方が勝つ。
   * どちらも共通の固定値（`GIT_TERMINAL_PROMPT` 等、`buildGitEnv` が最後に被せる）には勝てない。
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * 読み取り系にだけ載せる上限（docs/02-git-command-map.md キャンセル・タイムアウト節）。
   * 値は git 層の定数（spawnGit.ts）に閉じ、`GitContext` には載せない。
   * 書き込み系・通信系には渡さない——人が待つと決めた操作を時間で切らないため。
   */
  readonly timeoutMs?: number;
}

/**
 * GitContext から GitCommand を組み立てる唯一の場所。
 *
 * 各コマンドがオブジェクトリテラルを手で書いていると、文脈に項目が増えたときに
 * **足し忘れた実装だけが静かに古い挙動のまま**になる（実際、`GIT_SSH_COMMAND` を
 * 通すために `env` を足したときがそれだった）。組み立てをここ 1 箇所に寄せ、
 * `packages/git/test/commandSeam.test.ts` が「commands/ に直書きが無いこと」を検査する。
 *
 * タイムアウトも同じ口から載せる。コマンド側が `{ gitPath, cwd, args, timeoutMs }` を
 * 手で書き直すと、上の「足し忘れ」がそのまま戻ってくるため。
 */
export function commandFor(
  ctx: GitContext,
  args: readonly string[],
  options: CommandOptions = {},
): GitCommand {
  const env = { ...ctx.env, ...options.env };
  return {
    gitPath: ctx.gitPath,
    cwd: ctx.cwd,
    args,
    // 空の env は渡さない（GitCommand の「このコマンドにだけ足す」意味を保つ）
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}
