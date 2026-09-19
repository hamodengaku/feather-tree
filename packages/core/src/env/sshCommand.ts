import { isAbsolute } from 'node:path';
import type { AppSettings } from '../settings/schema.js';

/**
 * 設定した SSH 秘密鍵を git に伝えるための `GIT_SSH_COMMAND` を組み立てる（決定 13 の追記）。
 *
 * **ここが引用規則の唯一の正本。** git は `GIT_SSH_COMMAND` を
 * *シェルのコマンド文字列として解釈する*（Git for Windows は同梱の sh を通す）ので、
 * パスをそのまま埋めると空白で引数が割れる。
 *
 * - **POSIX のシングルクォート**で囲む。ダブルクォートは中の `$` と `` ` `` が展開される
 * - 値の中の `'` は `'\''`（閉じる → エスケープした `'` → 開き直す）に置換する
 * - **`\` は `/` に変換する。** sh は `\` をエスケープとして食うため
 *   （`C:\Users\me` が `C:Usersme` になる）。git は Windows でも `/` 区切りを受け付ける
 *
 * `-o IdentitiesOnly=yes` を付けるのは、ssh-agent に鍵が多数載っている環境で
 * ssh が順に試して `Too many authentication failures` になるのを避けるため。
 * 「この鍵を使う」と指定した以上、それだけを試すのが期待動作（決定 13 の追記）。
 *
 * 不正な値（相対パス・制御文字・空）では null を返す＝**何も注入しない**。
 * 注入しなければ、ユーザー自身の `GIT_SSH_COMMAND` / `core.sshCommand` がそのまま効く
 * （決定 13 の「OS の機構に完全委譲」を壊さない）。
 */
export function buildSshCommand(keyPath: string | null): string | null {
  if (keyPath === null || keyPath.length === 0) return null;
  if (!isAbsolute(keyPath)) return null;
  for (let i = 0; i < keyPath.length; i += 1) {
    const code = keyPath.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }

  const posix = keyPath.split('\\').join('/');
  const quoted = posix.split("'").join("'\\''");
  return "ssh -i '" + quoted + "' -o IdentitiesOnly=yes";
}

/**
 * 設定から、git に足す環境変数を作る。
 *
 * 鍵が未設定（あるいは不正）なら**空**を返す。呼び出し側は結果をそのまま
 * `GitContext.env` / `CloneRunDeps.env` に渡せばよい。
 * ここで作った値が効くのは**このアプリが spawn した git だけ**で、
 * ユーザーの環境変数にも git config にも一切触れない（CLAUDE.md 規約 3）。
 */
export function gitSshEnv(settings: AppSettings): Readonly<Record<string, string>> {
  const command = buildSshCommand(settings.sshKeyPath);
  return command === null ? {} : { GIT_SSH_COMMAND: command };
}
