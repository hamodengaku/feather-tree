/*
 * クローン URL の資格情報マスク（脆弱性診断 §11 Medium）。
 *
 * `https://user:TOKEN@host/repo.git` のように利用者自身が URL に資格情報を埋め込んだ場合、
 * cloneRunner.ts の生ログ・コマンドログ（決定 16「引数は伏せずに全部記録する」の唯一の例外）・
 * git の stderr（エラー表示）にそのまま平文で残ってしまう。ここでは userinfo
 * （`scheme://<userinfo>@`）だけを `***` に置換する。コマンド自体の可視性（決定 16 の意図）は
 * 保ったまま、資格情報だけを隠せるので決定との衝突は小さい。
 *
 * 実際に git に渡す引数（cloneRepository への url）は変えない。ここを通すのは
 * 表示・記録用にコピーした文字列だけ。
 *
 * scp 形式（`user@host:path`。ssh の**ユーザー名**であってパスワードではない）は
 * `://` を含まないため対象にしない。
 *
 * 不正な文字列・URL でも例外を投げない。URL として厳密に解析しようとはせず、
 * `://` の直後から最初の `/`（または空白・文字列終端）までの間に `@` がある場合にだけ、
 * その手前を `***` に置換する堅牢さで十分とする。stderr のような自由形式の文章の中に
 * URL が埋まっているケースにもそのまま使えるよう、文字列全体を対象にグローバルに置換する。
 */
const SCHEME_USERINFO = /:\/\/([^/\s]*)@/g;

export function redactUrl(text: string): string {
  return text.replace(SCHEME_USERINFO, '://***@');
}
