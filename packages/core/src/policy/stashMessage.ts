/**
 * stash のメッセージ（対応表 #27 の `--message=<msg>`）として渡してよい値の判定。
 *
 * `policy/gitIdentity.ts` と同じ趣旨で、**「git が受け取ってくれるか」ではなく
 * 「こちらの出力形式を壊さないか」**で見る。
 *
 * 実測（docs/02-git-command-map.md #27 の注記）:
 *  - 一覧（#28）の `%gs` は**改行を空白へ潰す**のでレコード境界（NUL）は壊れない
 *  - しかし **`US`（0x1f）はそのまま通る**。区切り文字なので、通すとフィールドがずれる
 *
 * つまり制御文字を弾くのは「安全のため」ではなく**一覧が壊れないため**であり、
 * ここを緩めると「メッセージに US を入れた stash が一覧から消える」形で表に出る。
 *
 * 純関数なので main からも renderer からも同じ答えになる（ボタンの出し分けと
 * 実際の拒否が食い違わない）。
 */

/** 保存できる長さの上限。reflog の 1 行なので、長すぎても読めない。 */
export const MAX_STASH_MESSAGE_LENGTH = 255;

export type StashMessageRejection =
  /** 空（空白だけを含む）。無題の stash は一覧で見分けられない */
  | 'empty'
  /** 改行・NUL・US などの制御文字。一覧のフィールドが壊れる */
  | 'control-char'
  | 'too-long';

/**
 * 渡してよい値に整えて返す。前後の空白は落とす（コピペ事故を持ち込まない）。
 *
 * **先頭 `-` は弾かない。** `--message=<msg>` は 1 引数なので、`-` で始まっても
 * オプションとして解釈される余地が無い（`-m <msg>` の形なら弾く必要があるが、
 * git 層はそちらを使わない）。理由の無い制限を足さないほうが素の git に近い。
 */
export function validateStashMessage(
  raw: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: StashMessageRejection } {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: 'empty' };
  if (value.length > MAX_STASH_MESSAGE_LENGTH) return { ok: false, reason: 'too-long' };
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return { ok: false, reason: 'control-char' };
  }
  return { ok: true, value };
}

/** 画面とエラー表示で同じ文言を使う。 */
export function describeStashMessageRejection(reason: StashMessageRejection): string {
  if (reason === 'empty') return 'stash のメッセージを入力してください。';
  if (reason === 'too-long') {
    return 'stash のメッセージが長すぎます（' + String(MAX_STASH_MESSAGE_LENGTH) + ' 文字まで）。';
  }
  return 'stash のメッセージに改行などの制御文字は使えません。';
}
