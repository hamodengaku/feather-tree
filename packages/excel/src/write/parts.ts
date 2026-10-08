/*
 * シート以外の部品の書き換え（docs/07-xlsx-cell-merge.md 4.3・5.3）。
 *
 *   - workbook.xml: 名前の定義の数式、`<calcPr fullCalcOnLoad="1">`
 *   - workbook.xml.rels / [Content_Types].xml: 計算順序（calcChain）の項を消す
 *   - テーブル・図・コメント・旧形式のコメントの図・グラフ・ピボットのキャッシュ: 行を変えたシートを指す所
 */

import { MAX_ROWS } from '../sheet/ref.js';
import { decodeUtf8 } from '../text/utf8.js';
import { XML_END, XML_EOF, XML_START, XML_TEXT, XmlScanner } from '../xml/scanner.js';
import { ByteEdits, escapeXmlAttr, escapeXmlText } from './edits.js';
import { remapFormula, remapRefText, type FormulaContext, type RowMap } from './refs.js';
import { SheetRewriteError } from './sheet.js';

/** 図の位置（0 始まりの行）。消えた行に掛かっていたら、次に残る行へ寄せる。 */
function anchorRow(map: RowMap, row: number): number {
  return map.range(row, MAX_ROWS - 1)?.[0] ?? row;
}

/** 要素の直下の文字を、名前（局所名）の親の下でだけ付け替える。 */
function rewriteTexts(
  bytes: Uint8Array,
  accept: (parent: string, grandparent: string | undefined) => boolean,
  transform: (text: string) => string,
): Uint8Array {
  const x = new XmlScanner(bytes);
  const edits = new ByteEdits();
  const stack: string[] = [];
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k === XML_START) {
      if (!x.selfClosing) stack.push(decodeUtf8(bytes, x.nameStart, x.nameEnd));
    } else if (k === XML_END) {
      stack.pop();
    } else if (k === XML_TEXT) {
      const parent = stack[stack.length - 1];
      if (parent === undefined || !accept(parent, stack[stack.length - 2])) continue;
      const text = x.text();
      const next = transform(text);
      if (next !== text) edits.replace(x.isCdata ? x.tokenStart : x.textStart, x.isCdata ? x.tokenEnd : x.textEnd, escapeXmlText(next));
    }
  }
  return edits.apply(bytes);
}

/** workbook.xml: 名前の定義の数式を付け替え、開いたときに全部を計算し直させる。 */
export function rewriteWorkbookPart(bytes: Uint8Array, ctx: FormulaContext): Uint8Array {
  const remapped = ctx.anyChanged
    ? rewriteTexts(bytes, (p) => p === 'definedName', (t) => remapFormula(t, ctx).text)
    : bytes;
  const x = new XmlScanner(remapped);
  const edits = new ByteEdits();
  /** calcPr を置ける位置（これらの要素の直後。workbook.xml の要素の順）。 */
  let insertAfter = -1;
  let depth = 0;
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k === XML_END) {
      depth -= 1;
      if (depth === 1 && (x.nameIs('sheets') || x.nameIs('functionGroups') || x.nameIs('externalReferences') || x.nameIs('definedNames'))) {
        insertAfter = x.tokenEnd;
      }
      continue;
    }
    if (k !== XML_START) continue;
    if (depth === 1 && x.nameIs('calcPr')) {
      if (x.attrRaw('fullCalcOnLoad')) edits.replace(x.valueStart, x.valueEnd, '1');
      else edits.insert(x.tokenEnd - (x.selfClosing ? 2 : 1), ' fullCalcOnLoad="1"');
      return edits.apply(remapped);
    }
    if (depth === 1 && x.selfClosing && (x.nameIs('functionGroups') || x.nameIs('definedNames'))) insertAfter = x.tokenEnd;
    if (!x.selfClosing) depth += 1;
  }
  if (insertAfter < 0) throw new SheetRewriteError('workbook.xml の形が想定と違います。');
  edits.insert(insertAfter, '<calcPr fullCalcOnLoad="1"/>');
  return edits.apply(remapped);
}

/** 関係（.rels）から、種類が type の項を消す。消したものが無ければ元のまま。 */
export function removeRelationship(bytes: Uint8Array, type: string): Uint8Array {
  const x = new XmlScanner(bytes);
  const edits = new ByteEdits();
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k !== XML_START || !x.nameIs('Relationship')) continue;
    const t = x.attr('Type');
    if (t !== null && t.slice(t.lastIndexOf('/') + 1) === type) {
      const start = x.tokenStart;
      x.skipElement();
      edits.remove(start, x.position);
    }
  }
  return edits.apply(bytes);
}

/** [Content_Types].xml から部品の Override を消す（partName は先頭の / 付き）。 */
export function removeContentTypeOverride(bytes: Uint8Array, partName: string): Uint8Array {
  const x = new XmlScanner(bytes);
  const edits = new ByteEdits();
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k !== XML_START || !x.nameIs('Override')) continue;
    if ((x.attr('PartName') ?? '').toLowerCase() === partName.toLowerCase()) {
      const start = x.tokenStart;
      x.skipElement();
      edits.remove(start, x.position);
    }
  }
  return edits.apply(bytes);
}

/** テーブル: ref・フィルタ・並べ替えの範囲。見出しの行が消えるなら断る。 */
export function rewriteTablePart(bytes: Uint8Array, map: RowMap): Uint8Array {
  const x = new XmlScanner(bytes);
  const edits = new ByteEdits();
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k !== XML_START) continue;
    if (!(x.nameIs('table') || x.nameIs('autoFilter') || x.nameIs('sortState') || x.nameIs('sortCondition'))) continue;
    const isTable = x.nameIs('table');
    const headerRows = isTable ? x.attrInt('headerRowCount', 1) : 0;
    if (!x.attrRaw('ref')) continue;
    const ref = decodeUtf8(bytes, x.valueStart, x.valueEnd);
    if (isTable && headerRows !== 0) {
      const head = /^\$?[A-Za-z]+\$?(\d+)/.exec(ref);
      const row = head?.[1] === undefined ? NaN : Number(head[1]) - 1;
      if (Number.isInteger(row) && map.point(row) === null) {
        throw new SheetRewriteError('テーブルの見出しの行を削除することはできません。');
      }
    }
    const next = remapRefText(ref, map);
    if (next === null) throw new SheetRewriteError('テーブル全体が消える行の削除は扱えません。');
    if (next !== ref) {
      x.attrRaw('ref');
      edits.replace(x.valueStart, x.valueEnd, escapeXmlAttr(next));
    }
  }
  return edits.apply(bytes);
}

/** 図（drawingN.xml）: `<xdr:from>` / `<xdr:to>` の `<xdr:row>`（0 始まり）。 */
export function rewriteDrawingPart(bytes: Uint8Array, map: RowMap): Uint8Array {
  return rewriteTexts(
    bytes,
    (parent, grandparent) => parent === 'row' && (grandparent === 'from' || grandparent === 'to'),
    (text) => {
      const n = Number(text.trim());
      return Number.isInteger(n) ? String(anchorRow(map, n)) : text;
    },
  );
}

/** 旧形式のコメントの図（vmlDrawingN.vml）: `<x:Row>` と `<x:Anchor>` の行。 */
export function rewriteVmlPart(bytes: Uint8Array, map: RowMap): Uint8Array {
  return rewriteTexts(
    bytes,
    (parent) => parent === 'Row' || parent === 'Anchor',
    (text) => {
      const parts = text.split(',');
      if (parts.length === 1) {
        const n = Number(text.trim());
        return Number.isInteger(n) ? String(anchorRow(map, n)) : text;
      }
      // 左列, 左オフセット, 上行, 上オフセット, 右列, 右オフセット, 下行, 下オフセット
      if (parts.length !== 8) return text;
      return parts
        .map((p, i) => {
          if (i !== 2 && i !== 6) return p;
          const n = Number(p.trim());
          return Number.isInteger(n) ? p.replace(p.trim(), String(anchorRow(map, n))) : p;
        })
        .join(',');
    },
  );
}

/** コメント（commentsN.xml・threadedComments）: `ref`。消える行のコメントは扱わない（図の側と対で消す必要があるため）。 */
export function rewriteCommentsPart(bytes: Uint8Array, map: RowMap): Uint8Array {
  const x = new XmlScanner(bytes);
  const edits = new ByteEdits();
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k !== XML_START || !(x.nameIs('comment') || x.nameIs('threadedComment'))) continue;
    if (!x.attrRaw('ref')) continue;
    const ref = decodeUtf8(bytes, x.valueStart, x.valueEnd);
    const next = remapRefText(ref, map);
    if (next === null) throw new SheetRewriteError('コメントの付いた行の削除は扱えません。');
    if (next !== ref) edits.replace(x.valueStart, x.valueEnd, escapeXmlAttr(next));
  }
  return edits.apply(bytes);
}

/** グラフ（chartN.xml）: `<c:f>` の数式。 */
export function rewriteChartPart(bytes: Uint8Array, ctx: FormulaContext): Uint8Array {
  return rewriteTexts(bytes, (parent) => parent === 'f', (t) => remapFormula(t, ctx).text);
}

/** ピボットのキャッシュの元の範囲（`<worksheetSource ref sheet>`）。 */
export function rewritePivotCachePart(bytes: Uint8Array, mapOf: (sheet: string) => RowMap | null): Uint8Array {
  const x = new XmlScanner(bytes);
  const edits = new ByteEdits();
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k !== XML_START || !x.nameIs('worksheetSource')) continue;
    const sheet = x.attr('sheet');
    const map = sheet === null ? null : mapOf(sheet);
    if (map === null || map.identity || !x.attrRaw('ref')) continue;
    const ref = decodeUtf8(bytes, x.valueStart, x.valueEnd);
    const next = remapRefText(ref, map);
    if (next === null) throw new SheetRewriteError('ピボットテーブルの元の範囲が消える行の削除は扱えません。');
    if (next !== ref) edits.replace(x.valueStart, x.valueEnd, escapeXmlAttr(next));
  }
  return edits.apply(bytes);
}
