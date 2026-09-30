/*
 * OPC のリレーションシップ（`_rels/*.rels`）。部品どうしの参照はここを通して解決する。
 *
 * 種類（Type）は URI の末尾で見る。transitional（`.../officeDocument/2006/relationships/worksheet`）と
 * strict（`http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet`）で前半が違うため。
 */

import { XML_EOF, XML_START, XmlScanner } from '../xml/scanner.js';

export interface Relationship {
  readonly id: string;
  /** Type の末尾（`worksheet` / `sharedStrings` / `styles` など）。 */
  readonly type: string;
  /** ZIP 内の絶対パス（先頭の `/` なし）。外部参照は null。 */
  readonly target: string | null;
}

/** `xl/workbook.xml` → `xl/_rels/workbook.xml.rels`。 */
export function relsPathOf(partPath: string): string {
  const slash = partPath.lastIndexOf('/');
  const dir = slash < 0 ? '' : partPath.slice(0, slash + 1);
  const file = partPath.slice(slash + 1);
  return dir + '_rels/' + file + '.rels';
}

export function parseRels(bytes: Uint8Array, sourcePart: string): Relationship[] {
  const out: Relationship[] = [];
  const x = new XmlScanner(bytes);
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k !== XML_START || !x.nameIs('Relationship')) continue;
    const id = x.attr('Id');
    const type = x.attr('Type');
    const target = x.attr('Target');
    if (id === null || type === null || target === null) continue;
    const external = x.attr('TargetMode') === 'External';
    const slash = type.lastIndexOf('/');
    out.push({
      id,
      type: type.slice(slash + 1),
      target: external ? null : resolvePart(sourcePart, target),
    });
  }
  return out;
}

/** 参照元の部品から見た Target を、ZIP 内の絶対パスにする。 */
export function resolvePart(sourcePart: string, target: string): string {
  const decoded = safeDecode(target.split('#')[0] ?? '');
  const baseDir = sourcePart.includes('/') ? sourcePart.slice(0, sourcePart.lastIndexOf('/')) : '';
  const segments = decoded.startsWith('/') ? [] : baseDir === '' ? [] : baseDir.split('/');
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') segments.pop();
    else segments.push(seg);
  }
  return segments.join('/');
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
