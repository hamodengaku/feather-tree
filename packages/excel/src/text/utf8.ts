/*
 * バイト範囲 → 文字列。
 *
 * **親の巨大な文字列の一部を切り出す（`slice`）形にしない。** V8 の部分文字列は親を掴んだままになり、
 * 数十 MB の XML を丸ごとヒープに残す（Unity モードで踏んだ落とし穴。決定 32 / F-1）。
 * ここでは常にバイトから**新しい**文字列を作る。
 *
 * 短い ASCII（セルの値・属性の大半）は TextDecoder を通すより自前で組むほうが速い。
 */

const decoder = new TextDecoder('utf-8');

/** これ以下の長さの ASCII は fromCharCode で組む。 */
const SHORT_ASCII = 32;

export function decodeUtf8(bytes: Uint8Array, start: number, end: number): string {
  const length = end - start;
  if (length <= 0) return '';
  if (length <= SHORT_ASCII) {
    let ascii = true;
    for (let i = start; i < end; i += 1) {
      if ((bytes[i] ?? 0) >= 0x80) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      let out = '';
      for (let i = start; i < end; i += 1) out += String.fromCharCode(bytes[i] ?? 0);
      return out;
    }
  }
  return decoder.decode(bytes.subarray(start, end));
}
