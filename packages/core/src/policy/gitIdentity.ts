/**
 * コミット情報（user.name / user.email）として保存してよい値の判定。
 *
 * `git config <キー> <値>` の値は位置引数なので、`fetch` / `push` のような
 * 明確なオプション注入口は無い（実測では先頭が `-` でも値として保存される。
 * docs/02-git-command-map.md #42〜#44 の表）。**つまりここが実質の唯一の防壁**であり、
 * 「git が受け取ってくれるかどうか」ではなく「設定ファイルと引数を壊さないか」で見る。
 *
 * 純関数なので main からも（同じ規則の写しとして）renderer からも同じ答えになる。
 */

/** 保存できる長さの上限。設定ファイルが無意味に育つのを防ぐ。 */
export const MAX_IDENTITY_LENGTH = 255;

export type IdentityRejection =
  /** 空（空白だけを含む）。--unset はしないので、空は保存しない */
  | 'empty'
  /** 先頭が `-`。他の git 版でオプションと解釈される余地を残さない */
  | 'leading-dash'
  /** 改行・NUL などの制御文字。.git/config の行構造を壊す */
  | 'control-char'
  | 'too-long';

/**
 * 保存する値に整えて返す。前後の空白は落とす（コピペ事故を持ち込まない）。
 * 保存できない値なら理由を返す。
 */
export function validateIdentityValue(
  raw: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: IdentityRejection } {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: 'empty' };
  if (value.length > MAX_IDENTITY_LENGTH) return { ok: false, reason: 'too-long' };
  if (value.startsWith('-')) return { ok: false, reason: 'leading-dash' };
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return { ok: false, reason: 'control-char' };
  }
  return { ok: true, value };
}

/** 画面とエラー表示で同じ文言を使う。 */
export function describeIdentityRejection(label: string, reason: IdentityRejection): string {
  if (reason === 'empty') {
    return (
      label +
      'を空にはできません。このリポジトリの設定を削除するには、' +
      'ターミナルで git config --local --unset を実行してください。'
    );
  }
  if (reason === 'leading-dash') return label + 'を「-」で始めることはできません。';
  if (reason === 'too-long') {
    return label + 'が長すぎます（' + String(MAX_IDENTITY_LENGTH) + ' 文字まで）。';
  }
  return label + 'に改行などの制御文字は使えません。';
}
