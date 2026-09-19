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
 * - **ssh 自身も絶対パスで、同じ規則で引用する。** bare 名を渡すと実行時の PATH 次第で
 *   どの ssh が動くか変わる（診断 1-A / 1-B。解決は sshLocator が行う）
 *
 * `-o IdentitiesOnly=yes` を付けるのは、ssh-agent に鍵が多数載っている環境で
 * ssh が順に試して `Too many authentication failures` になるのを避けるため。
 * 「この鍵を使う」と指定した以上、それだけを試すのが期待動作（決定 13 の追記）。
 *
 * ssh か鍵のどちらかが無い／不正（相対パス・制御文字・空）なら null を返す＝
 * **何も注入しない**。注入しなければ、ユーザー自身の `GIT_SSH_COMMAND` /
 * `core.sshCommand` がそのまま効く（決定 13 の「OS の機構に完全委譲」を壊さない）。
 */
export function buildSshCommand(sshPath: string | null, keyPath: string | null): string | null {
  const ssh = quoteForShell(sshPath);
  const key = quoteForShell(keyPath);
  if (ssh === null || key === null) return null;
  return ssh + ' -i ' + key + ' -o IdentitiesOnly=yes';
}

/** 絶対パスを、POSIX シェルで 1 語に戻るシングルクォート表記にする。不正なら null。 */
function quoteForShell(path: string | null): string | null {
  if (path === null || path.length === 0) return null;
  if (!isAbsolute(path)) return null;
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }

  const posix = path.split('\\').join('/');
  return "'" + posix.split("'").join("'\\''") + "'";
}

/**
 * そのリポジトリに登録された鍵。未登録なら null。
 *
 * 鍵は**リポジトリごと**に持つ（決定 13 の 2026-09-19 改定 2）。ホストごとに鍵を
 * 使い分けるのが普通で、アプリ全体に 1 本だと別ホストの認証を巻き添えにするため。
 */
export function sshKeyFor(settings: AppSettings, repositoryRoot: string): string | null {
  return settings.sshKeyPaths[repositoryRoot] ?? null;
}

/**
 * そのリポジトリで git に足す環境変数を作る。
 *
 * 鍵が未登録（あるいは ssh が見つかっていない）なら**空**を返す。呼び出し側は
 * 結果をそのまま `GitContext.env` へ渡せばよい。ここで作った値が効くのは
 * **このアプリが spawn した git だけ**で、ユーザーの環境変数にも git config の
 * ファイルにも一切触れない（CLAUDE.md 規約 3）。
 * ただし git の解決順では `core.sshCommand` に優先する点に注意。
 */
export function gitSshEnv(
  sshPath: string | null,
  keyPath: string | null,
): Readonly<Record<string, string>> {
  const command = buildSshCommand(sshPath, keyPath);
  return command === null ? {} : { GIT_SSH_COMMAND: command };
}
