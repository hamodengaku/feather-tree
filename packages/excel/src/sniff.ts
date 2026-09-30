/*
 * 先頭のバイトだけで「何のファイルか」を見分ける（決定 33）。
 *
 * ZIP として開く前に、明らかに違うものをここで落とす。
 *   - `cfb`         … OLE 複合文書。旧形式の `.xls` と、**パスワード付きの `.xlsx`**（暗号化すると
 *                     ZIP ではなく CFB の中に暗号化済みの本体が入る）の両方がこれになる
 *   - `lfs-pointer` … Git LFS のポインタ（実体をまだ取ってきていない作業ツリー）
 */

export type ExcelSniff = 'zip' | 'cfb' | 'lfs-pointer' | 'empty' | 'unknown';

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const LFS_PREFIX = 'version https://git-lfs.github.com/spec/';

export function sniffExcel(bytes: Uint8Array): ExcelSniff {
  if (bytes.length === 0) return 'empty';
  // PK\x03\x04（通常）/ PK\x05\x06（要素ゼロの ZIP）
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const a = bytes[2];
    const b = bytes[3];
    if ((a === 0x03 && b === 0x04) || (a === 0x05 && b === 0x06)) return 'zip';
  }
  if (bytes.length >= CFB_SIGNATURE.length && CFB_SIGNATURE.every((v, i) => bytes[i] === v)) return 'cfb';
  if (startsWithAscii(bytes, LFS_PREFIX)) return 'lfs-pointer';
  return 'unknown';
}

function startsWithAscii(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[i] !== text.charCodeAt(i)) return false;
  }
  return true;
}
