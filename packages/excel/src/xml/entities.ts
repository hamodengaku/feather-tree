/*
 * XML の実体参照と、OOXML 独自の `_xHHHH_` の復元。
 *
 * どちらも**知らない形はそのまま残す**（例外を投げない・文字を落とさない）。
 */

const AMP = '&';

/** `&lt;` `&gt;` `&amp;` `&quot;` `&apos;` `&#nnn;` `&#xhh;` を戻す。 */
export function unescapeXml(text: string): string {
  if (!text.includes(AMP)) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const amp = text.indexOf(AMP, i);
    if (amp < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, amp);
    // 実体参照は短い。; は 12 文字以内でしか探さない（末尾まで探すと、& を並べただけの入力で n² になる）
    const semi = findSemicolon(text, amp + 1, Math.min(text.length, amp + 13));
    if (semi < 0) {
      out += AMP;
      i = amp + 1;
      continue;
    }
    const body = text.slice(amp + 1, semi);
    const decoded = decodeEntity(body);
    if (decoded === null) {
      out += AMP;
      i = amp + 1;
      continue;
    }
    out += decoded;
    i = semi + 1;
  }
  return out;
}

function findSemicolon(text: string, from: number, to: number): number {
  for (let i = from; i < to; i += 1) if (text.charCodeAt(i) === 59) return i;
  return -1;
}

function decodeEntity(body: string): string | null {
  switch (body) {
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'amp':
      return '&';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
    default:
      break;
  }
  if (body.charCodeAt(0) !== 35 /* # */) return null;
  const hex = body.charCodeAt(1) === 120 /* x */ || body.charCodeAt(1) === 88; /* X */
  const digits = hex ? body.slice(2) : body.slice(1);
  if (digits.length === 0) return null;
  const code = Number.parseInt(digits, hex ? 16 : 10);
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || !isAllDigits(digits, hex)) return null;
  return String.fromCodePoint(code);
}

function isAllDigits(s: string, hex: boolean): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    const dec = c >= 48 && c <= 57;
    const hx = (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    if (!dec && !(hex && hx)) return false;
  }
  return true;
}

/**
 * OOXML の `_xHHHH_` を戻す（共有文字列・インライン文字列）。
 *
 * Excel は XML に書けない文字（CR や制御文字）を `_x000D_` のように書く。
 * 本物の `_x000D_` という文字列は `_x005F_x000D_`（`_` 自体を `_x005F_` で逃がす）と書かれる。
 */
export function unescapeOoxml(text: string): string {
  if (!text.includes('_x')) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('_x', i);
    if (at < 0 || at + 7 > text.length) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, at);
    const hex = text.slice(at + 2, at + 6);
    if (text.charCodeAt(at + 6) === 95 /* _ */ && /^[0-9A-Fa-f]{4}$/.test(hex)) {
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i = at + 7;
    } else {
      out += '_';
      i = at + 1;
    }
  }
  return out;
}
