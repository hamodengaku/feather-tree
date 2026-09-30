/*
 * 共有文字列（`xl/sharedStrings.xml`）。
 *
 * `<si>` 1 つが文字列 1 つ。中身は `<t>` 1 つか、書式違いの断片 `<r><t>` の並び（リッチテキスト）で、
 * 断片は連結して 1 つの文字列にする（M1 では書式を捨てる）。
 *
 * **ふりがな（`<rPh><t>`）は読み飛ばす。** 日本語の Excel は入力時の読みを `<rPh>` に残すので、
 * 拾うと「東京トウキョウ」のように読みが本文に混ざる。
 */

import { unescapeOoxml } from '../xml/entities.js';
import { XML_END, XML_EOF, XML_START, XmlScanner } from '../xml/scanner.js';

export function parseSharedStrings(bytes: Uint8Array, maxCount = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  const x = new XmlScanner(bytes);
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k !== XML_START || !x.nameIs('si')) continue;
    // 件数の上限。超えた分の添字を持つセルは空の文字列になる
    if (out.length >= maxCount) break;
    out.push(x.selfClosing ? '' : readStringItem(x));
  }
  return out;
}

/**
 * `<si>` / `<is>` の中身を読む（開始タグの直後から、対応する終了タグまで）。
 * インライン文字列（`<c t="inlineStr"><is>...</is></c>`）も同じ形なので共用する。
 */
export function readStringItem(x: XmlScanner): string {
  let text = '';
  let depth = 0;
  for (;;) {
    const k = x.next();
    if (k === XML_EOF) break;
    if (k === XML_START) {
      if (x.nameIs('t')) {
        text += x.readElementText();
        continue;
      }
      if (x.nameIs('rPh') || x.nameIs('phoneticPr')) {
        x.skipElement();
        continue;
      }
      if (!x.selfClosing) depth += 1;
      continue;
    }
    if (k === XML_END) {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  return unescapeOoxml(text);
}
