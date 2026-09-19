import { commandFor } from '../execution/gitCommand.js';
import { GitCommandError } from '../execution/errors.js';
import { READ_PREFIX, WRITE_PREFIX } from '../execution/gitEnvironment.js';
import { runGitText } from '../execution/spawnGit.js';
import type { GitContext } from './context.js';

/** 読み書きするキー。固定の 2 つだけ（任意のキーを触る口は作らない）。 */
export type IdentityKey = 'name' | 'email';

/** その値がどこから来ているか。 */
export type IdentityScope =
  /** このリポジトリの .git/config にある */
  | 'local'
  /** ローカルには無く、global / system の値が使われている */
  | 'inherited'
  /** どこにも無い */
  | 'unset';

export interface IdentityField {
  readonly value: string | null;
  readonly scope: IdentityScope;
}

export interface UserIdentity {
  readonly name: IdentityField;
  readonly email: IdentityField;
}

const KEY_PATTERN = '^user\\.(name|email)$';

/**
 * `--get-regexp -z` の出力を読む。
 *
 * 1 レコードは **`<キー>\n<値>\0`**（区切りは `=` ではなく改行）。
 * **最初の改行だけで分割する**——値に改行が入っていても壊さないため
 * （実測で確認済み。docs/02-git-command-map.md #42〜#44 の表）。
 */
function parseConfigZ(stdout: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const record of stdout.split('\0')) {
    if (record.length === 0) continue;
    const cut = record.indexOf('\n');
    // 値が空の設定（`user.name =`）はキーだけのレコードになる
    if (cut === -1) {
      found.set(record, '');
      continue;
    }
    found.set(record.slice(0, cut), record.slice(cut + 1));
  }
  return found;
}

/**
 * `config --get-regexp` を 1 回実行する。
 *
 * **一致が 0 件のとき git は終了コード 1 を返す。** これは失敗ではなく「未設定」なので
 * 空の結果として扱う（実測で確認済み）。それ以外の異常だけ例外にする。
 */
async function readScope(ctx: GitContext, local: boolean): Promise<Map<string, string>> {
  const args = local
    ? [...READ_PREFIX, 'config', '--local', '-z', '--get-regexp', KEY_PATTERN]
    : [...READ_PREFIX, 'config', '-z', '--get-regexp', KEY_PATTERN];

  const { exit, stdout } = await runGitText(commandFor(ctx, args), ctx.signal);
  if (exit.code === 1) return new Map();
  if (exit.code !== 0) throw new GitCommandError(['config', '--get-regexp'], exit.code, exit.stderr);
  return parseConfigZ(stdout);
}

/**
 * 対応表 #42（→ 必要なら #43）: コミット情報（user.name / user.email）を読む。
 *
 * ローカルに両方あれば **#43 は実行しない**（有効値はローカルの値と一致するため、
 * プロセスを増やす意味が無い）。欠けているキーがあるときだけ有効値を引き、
 * 「global から来ている」のか「どこにも無い」のかを見分ける。
 *
 * `--show-scope` を使わないのは git 2.26 以降の機能で、このアプリの最低要求が 2.25 のため。
 */
export async function readUserIdentity(ctx: GitContext): Promise<UserIdentity> {
  const local = await readScope(ctx, true);
  const missing = (['name', 'email'] as const).some((k) => !local.has('user.' + k));
  const effective = missing ? await readScope(ctx, false) : new Map<string, string>();

  const field = (key: IdentityKey): IdentityField => {
    const localValue = local.get('user.' + key);
    if (localValue !== undefined) return { value: localValue, scope: 'local' };
    const inherited = effective.get('user.' + key);
    if (inherited !== undefined) return { value: inherited, scope: 'inherited' };
    return { value: null, scope: 'unset' };
  };

  return { name: field('name'), email: field('email') };
}

/**
 * 対応表 #44: コミット情報の 1 キーを**このリポジトリの .git/config** に書く。
 *
 * `git config` は 1 回の実行で 1 キーしか設定できないので、name と email の両方を
 * 変えるときは呼び出し側が 2 回呼ぶ（変えたキーだけ打つ。例外表を参照）。
 *
 * 値の直前に `--` を置く。実測では `--` が無くても先頭が `-` の値は
 * オプションとして解釈されず値として保存されるが、他の git 版への保険として置く。
 * **実質の防壁は呼び出し側（core の validateIdentityValue）の検証**であり、ここではない。
 */
export async function setLocalUserIdentity(
  ctx: GitContext,
  key: IdentityKey,
  value: string,
): Promise<void> {
  const { exit } = await runGitText(
    commandFor(ctx, [...WRITE_PREFIX, 'config', '--local', '--', 'user.' + key, value]),
    ctx.signal,
  );
  if (exit.code !== 0) throw new GitCommandError(['config', 'user.' + key], exit.code, exit.stderr);
}
