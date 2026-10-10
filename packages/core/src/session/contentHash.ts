import { createHash } from 'node:crypto';

/**
 * 中身の指紋（sha1 の 16 進）。未マージのファイルを書き戻す直前に、比較を作ったときと同じ中身かを照合するのに使う
 * （Excel の作業ツリー・index の段〔決定 34〕、Unity の作業ツリー〔決定 32〕）。文字列は UTF-8 のバイト列で数える。
 */
export function contentHash(data: Uint8Array | string): string {
  return createHash('sha1').update(data).digest('hex');
}
