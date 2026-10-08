/*
 * 相手側のセルを `<c>` として書く（docs/07-xlsx-cell-merge.md 4.1・4.3）。
 *
 * 共有文字列は土台の sharedStrings.xml を書き換えずに済むよう**インライン文字列**にする。相手側の `<si>` の
 * 中身（リッチテキストの `<r>`・ふりがなの `<rPh>` を含む）をそのまま `<is>` に写すので、文字ごとの書式も残る。
 */

import {
  CELL_BLANK,
  CELL_BOOL,
  CELL_DATE,
  CELL_ERROR,
  CELL_FORMULA_STR,
  CELL_INLINE,
  CELL_NUMBER,
  CELL_SHARED,
  type CellData,
} from '../model/types.js';
import { decodeUtf8 } from '../text/utf8.js';
import { XML_END, XML_EOF, XML_START, XmlScanner } from '../xml/scanner.js';
import { escapeXmlAttr, escapeXmlText } from './edits.js';

/** sharedStrings.xml の `<si>` の中身（XML のまま）を並べる。 */
export function rawSharedStringItems(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const x = new XmlScanner(bytes);
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k !== XML_START || !x.nameIs('si')) continue;
    if (x.selfClosing) {
      out.push('');
      continue;
    }
    const inner = x.tokenEnd;
    let end = inner;
    let depth = 0;
    for (let c = x.next(); c !== XML_EOF; c = x.next()) {
      if (c === XML_START && !x.selfClosing) depth += 1;
      else if (c === XML_END) {
        if (depth === 0) {
          end = x.tokenStart;
          break;
        }
        depth -= 1;
      }
    }
    out.push(decodeUtf8(bytes, inner, end));
  }
  return out;
}

function textElement(text: string): string {
  return `<is><t xml:space="preserve">${escapeXmlText(text)}</t></is>`;
}

export interface CellWrite {
  readonly cell: CellData;
  /** 土台の cellXfs の添字（付け替え済み）。 */
  readonly style: number;
  /** 書く数式（付け替え済み）。無ければ null。 */
  readonly formula: string | null;
  /** 共有文字列なら、相手側の `<si>` の中身。 */
  readonly sharedInner: string | null;
  /** 共有文字列の本文（`<si>` の中身が取れなかったときの代わり）。 */
  readonly sharedText: string;
}

/** `<c>` 要素を 1 つ書く。値も数式も書式も無ければ空文字（セルを置かない）。 */
export function cellXml(ref: string, w: CellWrite): string {
  const { cell, style, formula } = w;
  const s = style !== 0 ? ` s="${String(style)}"` : '';
  const f = formula === null ? '' : `<f>${escapeXmlText(formula)}</f>`;
  const open = (t: string): string => `<c r="${escapeXmlAttr(ref)}"${s}${t}>`;
  switch (cell.kind) {
    case CELL_NUMBER:
      return `${open('')}${f}<v>${String(cell.num)}</v></c>`;
    case CELL_BOOL:
      return `${open(' t="b"')}${f}<v>${cell.num !== 0 ? '1' : '0'}</v></c>`;
    case CELL_ERROR:
      return `${open(' t="e"')}${f}<v>${escapeXmlText(cell.text ?? '')}</v></c>`;
    case CELL_DATE:
      return `${open(' t="d"')}${f}<v>${escapeXmlText(cell.text ?? '')}</v></c>`;
    case CELL_FORMULA_STR:
      return `${open(' t="str"')}${f}<v>${escapeXmlText(cell.text ?? '')}</v></c>`;
    case CELL_SHARED: {
      // 数式の結果が共有文字列になることは無い（Excel は t="str" で書く）が、来たら文字列の結果として書く
      if (formula !== null) return `${open(' t="str"')}${f}<v>${escapeXmlText(w.sharedText)}</v></c>`;
      const body = w.sharedInner !== null ? `<is>${w.sharedInner}</is>` : textElement(w.sharedText);
      return `${open(' t="inlineStr"')}${body}</c>`;
    }
    case CELL_INLINE:
      if (formula !== null) return `${open(' t="str"')}${f}<v>${escapeXmlText(cell.text ?? '')}</v></c>`;
      return `${open(' t="inlineStr"')}${textElement(cell.text ?? '')}</c>`;
    case CELL_BLANK:
    default:
      if (formula !== null) return `${open('')}${f}</c>`;
      if (style === 0) return '';
      return `<c r="${escapeXmlAttr(ref)}"${s}/>`;
  }
}
