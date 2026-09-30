/*
 * SpreadsheetML を読むための、バイト列の上を進む XML 走査器（決定 33）。
 *
 * 汎用の XML パーサではない。Excel が書き出す部分集合（要素・属性・文字・CDATA・コメント・処理命令）
 * だけを読み、DTD や外部実体は解釈しない（外部実体の展開をしないので、XXE の余地も無い）。
 *
 * **タグ名を文字列にしない。** 100 万セルのシートでは `<c>` `<v>` が数百万回現れるので、
 * 名前はバイト範囲のまま `nameIs('c')` で比べる。接頭辞（`x:c` の `x:`）は落として局所名で比べる
 * ——strict 形式や他のツールが書いた xlsx は接頭辞付きで来ることがある。
 *
 * UTF-8 の多バイト文字は 0x80 以上のバイトだけでできているので、`<` `>` `"` などの ASCII を
 * バイトのまま探しても文字の途中に誤って当たることはない。
 *
 * **例外を投げない。** 閉じていないタグ・引用符は、見つかったところまでで打ち切る。
 */

import { decodeUtf8 } from '../text/utf8.js';
import { unescapeXml } from './entities.js';

export const XML_EOF = 0;
export const XML_START = 1;
export const XML_END = 2;
export const XML_TEXT = 3;

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const EQUALS = 0x3d;
const COLON = 0x3a;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const AMP = 0x26;

function isSpace(c: number | undefined): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

export class XmlScanner {
  readonly #b: Uint8Array;
  readonly #end: number;
  #pos: number;

  /** 直前の `next()` の結果。 */
  kind = XML_EOF;
  /** 開始・終了タグの局所名の範囲。 */
  nameStart = 0;
  nameEnd = 0;
  /** 開始タグの属性部分の範囲。 */
  #attrStart = 0;
  #attrEnd = 0;
  /** `<x/>` の形か。 */
  selfClosing = false;
  /** 文字の範囲（XML_TEXT）。 */
  #textStart = 0;
  #textEnd = 0;
  #cdata = false;
  /** 属性値の範囲（`attrRaw` が当たったとき）。 */
  valueStart = 0;
  valueEnd = 0;

  constructor(bytes: Uint8Array, start = 0, end = bytes.length) {
    this.#b = bytes;
    this.#pos = start;
    this.#end = Math.min(end, bytes.length);
    // UTF-8 の BOM
    if (bytes[start] === 0xef && bytes[start + 1] === 0xbb && bytes[start + 2] === 0xbf) this.#pos += 3;
  }

  get bytes(): Uint8Array {
    return this.#b;
  }

  next(): number {
    const b = this.#b;
    for (;;) {
      const pos = this.#pos;
      if (pos >= this.#end) return (this.kind = XML_EOF);

      if (b[pos] !== LT) {
        const lt = this.#indexOf(LT, pos);
        this.#textStart = pos;
        this.#textEnd = lt;
        this.#cdata = false;
        this.#pos = lt;
        return (this.kind = XML_TEXT);
      }

      const c1 = b[pos + 1];
      if (c1 === BANG) {
        // <!-- コメント -->
        if (b[pos + 2] === 0x2d && b[pos + 3] === 0x2d) {
          this.#pos = this.#skipPast(pos + 4, '-->');
          continue;
        }
        // <![CDATA[ ... ]]>
        if (this.#matches(pos + 2, '[CDATA[')) {
          const bodyStart = pos + 9;
          const close = this.#find(bodyStart, ']]>');
          this.#textStart = bodyStart;
          this.#textEnd = close;
          this.#cdata = true;
          this.#pos = Math.min(this.#end, close + 3);
          return (this.kind = XML_TEXT);
        }
        // <!DOCTYPE ...> などは読み飛ばす（DTD は解釈しない）
        this.#pos = this.#skipDeclaration(pos + 2);
        continue;
      }
      if (c1 === QUESTION) {
        this.#pos = this.#skipPast(pos + 2, '?>');
        continue;
      }

      if (c1 === SLASH) {
        this.#readName(pos + 2);
        const gt = this.#indexOf(GT, this.nameEnd);
        this.#pos = Math.min(this.#end, gt + 1);
        this.selfClosing = false;
        return (this.kind = XML_END);
      }

      const afterName = this.#readName(pos + 1);
      // 属性部分は引用符の中の > を飛ばしながら閉じ > を探す
      let at = afterName;
      let quote = 0;
      while (at < this.#end) {
        const c = b[at];
        if (quote !== 0) {
          if (c === quote) quote = 0;
        } else if (c === DQUOTE || c === SQUOTE) {
          quote = c;
        } else if (c === GT) {
          break;
        }
        at += 1;
      }
      this.selfClosing = at > afterName && b[at - 1] === SLASH;
      this.#attrStart = afterName;
      this.#attrEnd = this.selfClosing ? at - 1 : at;
      this.#pos = Math.min(this.#end, at + 1);
      return (this.kind = XML_START);
    }
  }

  /** 局所名が `name`（ASCII）と一致するか。 */
  nameIs(name: string): boolean {
    const len = this.nameEnd - this.nameStart;
    if (len !== name.length) return false;
    const b = this.#b;
    for (let i = 0; i < len; i += 1) {
      if (b[this.nameStart + i] !== name.charCodeAt(i)) return false;
    }
    return true;
  }

  /** 局所名を文字列で（診断・まれな分岐用）。 */
  name(): string {
    return decodeUtf8(this.#b, this.nameStart, this.nameEnd);
  }

  /**
   * 属性を局所名で探し、値の範囲を `valueStart` / `valueEnd` に置く。無ければ false。
   * `xmlns` / `xmlns:*` は名前空間宣言なので対象にしない（`xmlns:r` を属性 `r` と取り違えない）。
   */
  attrRaw(localName: string): boolean {
    const b = this.#b;
    let at = this.#attrStart;
    const end = this.#attrEnd;
    while (at < end) {
      while (at < end && isSpace(b[at])) at += 1;
      if (at >= end) break;
      const nameStart = at;
      let localStart = at;
      while (at < end && b[at] !== EQUALS && !isSpace(b[at])) {
        if (b[at] === COLON) localStart = at + 1;
        at += 1;
      }
      const nameEnd = at;
      while (at < end && isSpace(b[at])) at += 1;
      if (b[at] !== EQUALS) {
        // 値の無い属性（XML としては不正）。次へ
        continue;
      }
      at += 1;
      while (at < end && isSpace(b[at])) at += 1;
      const quote = b[at];
      if (quote !== DQUOTE && quote !== SQUOTE) continue;
      const valueStart = at + 1;
      let valueEnd = valueStart;
      while (valueEnd < end && b[valueEnd] !== quote) valueEnd += 1;
      at = valueEnd + 1;

      if (this.#isXmlns(nameStart, nameEnd, localStart)) continue;
      if (this.#rangeIs(localStart, nameEnd, localName)) {
        this.valueStart = valueStart;
        this.valueEnd = valueEnd;
        return true;
      }
    }
    return false;
  }

  /** 属性の値（実体参照を戻した文字列）。無ければ null。 */
  attr(localName: string): string | null {
    if (!this.attrRaw(localName)) return null;
    return this.#decode(this.valueStart, this.valueEnd, false);
  }

  /** 整数の属性。無い・読めないなら fallback。 */
  attrInt(localName: string, fallback: number): number {
    if (!this.attrRaw(localName)) return fallback;
    return parseIntRange(this.#b, this.valueStart, this.valueEnd, fallback);
  }

  /** 数値の属性。無い・読めないなら fallback。 */
  attrNumber(localName: string, fallback: number): number {
    const text = this.attr(localName);
    if (text === null) return fallback;
    const v = Number(text);
    return Number.isFinite(v) && text.trim() !== '' ? v : fallback;
  }

  /** 真偽の属性（`1` / `true`）。無ければ fallback。 */
  attrBool(localName: string, fallback: boolean): boolean {
    if (!this.attrRaw(localName)) return fallback;
    const b = this.#b;
    const len = this.valueEnd - this.valueStart;
    if (len === 1) return b[this.valueStart] === 0x31;
    if (len === 4) return this.#rangeIs(this.valueStart, this.valueEnd, 'true');
    return fallback;
  }

  /** 直前の XML_TEXT の中身。 */
  text(): string {
    return this.#decode(this.#textStart, this.#textEnd, this.#cdata);
  }

  /**
   * 直前の XML_START の要素の、直下の文字を連結して返し、終了タグまで進む。
   * 子要素の中身は飛ばす（`<t>` や `<v>` は子を持たないので、実際には飛ばすものは無い）。
   */
  readElementText(): string {
    if (this.kind !== XML_START || this.selfClosing) return '';
    let out = '';
    let depth = 0;
    for (;;) {
      const k = this.next();
      if (k === XML_EOF) return out;
      if (k === XML_TEXT) {
        if (depth === 0) out += this.text();
      } else if (k === XML_START) {
        if (!this.selfClosing) depth += 1;
      } else if (k === XML_END) {
        if (depth === 0) return out;
        depth -= 1;
      }
    }
  }

  /** 直前の XML_START の要素を、終了タグまで読み飛ばす。 */
  skipElement(): void {
    if (this.kind !== XML_START || this.selfClosing) return;
    let depth = 0;
    for (;;) {
      const k = this.next();
      if (k === XML_EOF) return;
      if (k === XML_START) {
        if (!this.selfClosing) depth += 1;
      } else if (k === XML_END) {
        if (depth === 0) return;
        depth -= 1;
      }
    }
  }

  // ------------------------------------------------------------ 内部

  #decode(start: number, end: number, raw: boolean): string {
    const text = decodeUtf8(this.#b, start, end);
    if (raw) return text;
    for (let i = start; i < end; i += 1) {
      if (this.#b[i] === AMP) return unescapeXml(text);
    }
    return text;
  }

  /** `<` の直後から名前を読み、局所名の範囲を置く。名前の直後の位置を返す。 */
  #readName(start: number): number {
    const b = this.#b;
    let at = start;
    let local = start;
    while (at < this.#end) {
      const c = b[at];
      if (c === GT || c === SLASH || isSpace(c)) break;
      if (c === COLON) local = at + 1;
      at += 1;
    }
    this.nameStart = local;
    this.nameEnd = at;
    return at;
  }

  #indexOf(byte: number, from: number): number {
    const at = this.#b.indexOf(byte, from);
    return at < 0 || at > this.#end ? this.#end : at;
  }

  #matches(at: number, text: string): boolean {
    if (at + text.length > this.#end) return false;
    for (let i = 0; i < text.length; i += 1) {
      if (this.#b[at + i] !== text.charCodeAt(i)) return false;
    }
    return true;
  }

  /** `text` が始まる位置（無ければ終端）。 */
  #find(from: number, text: string): number {
    const first = text.charCodeAt(0);
    let at = from;
    while (at < this.#end) {
      const hit = this.#b.indexOf(first, at);
      if (hit < 0 || hit >= this.#end) return this.#end;
      if (this.#matches(hit, text)) return hit;
      at = hit + 1;
    }
    return this.#end;
  }

  #skipPast(from: number, text: string): number {
    const at = this.#find(from, text);
    return Math.min(this.#end, at + text.length);
  }

  /** `<!DOCTYPE ...[ ... ]>` を読み飛ばす（中身は解釈しない）。 */
  #skipDeclaration(from: number): number {
    let at = from;
    let bracket = 0;
    while (at < this.#end) {
      const c = this.#b[at];
      if (c === 0x5b) bracket += 1;
      else if (c === 0x5d) bracket = Math.max(0, bracket - 1);
      else if (c === GT && bracket === 0) return at + 1;
      at += 1;
    }
    return this.#end;
  }

  #rangeIs(start: number, end: number, text: string): boolean {
    if (end - start !== text.length) return false;
    for (let i = 0; i < text.length; i += 1) {
      if (this.#b[start + i] !== text.charCodeAt(i)) return false;
    }
    return true;
  }

  #isXmlns(nameStart: number, nameEnd: number, localStart: number): boolean {
    if (localStart === nameStart) return this.#rangeIs(nameStart, nameEnd, 'xmlns');
    return this.#rangeIs(nameStart, localStart - 1, 'xmlns');
  }
}

/** バイト範囲の 10 進整数（前後の空白・符号を許す）。読めなければ fallback。 */
export function parseIntRange(b: Uint8Array, start: number, end: number, fallback: number): number {
  let at = start;
  while (at < end && isSpace(b[at])) at += 1;
  let sign = 1;
  if (b[at] === 0x2d) {
    sign = -1;
    at += 1;
  } else if (b[at] === 0x2b) {
    at += 1;
  }
  let value = 0;
  let digits = 0;
  while (at < end) {
    const c = b[at] ?? 0;
    if (c < 0x30 || c > 0x39) break;
    value = value * 10 + (c - 0x30);
    digits += 1;
    at += 1;
  }
  while (at < end && isSpace(b[at])) at += 1;
  if (digits === 0 || at !== end || digits > 15) return fallback;
  return sign * value;
}
