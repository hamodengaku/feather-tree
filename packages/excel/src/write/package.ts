/*
 * 書き換えのためにブックの部品の構成を読む（docs/07-xlsx-cell-merge.md）。
 *
 * 読み取り器（workbook/workbook.ts）はセルの中身を読むためのもので、部品のパスや関係を外へ出さない。
 * 書き換えでは「どのシートがどの部品か」「そのシートがどんな部品と関係を持つか（行をずらしてよいか）」
 * 「テーブルの見出しがどこか」が要るので、ここで読む。
 */

import { DEFAULT_LIMITS, type ExcelLimits } from '../limits.js';
import { parseRels, relsPathOf, type Relationship } from '../opc/rels.js';
import { parseRange } from '../sheet/ref.js';
import { XML_EOF, XML_START, XmlScanner } from '../xml/scanner.js';
import { openZip, readZipEntry, type Inflater, type ZipArchive } from '../zip/reader.js';

export interface SheetPart {
  readonly name: string;
  readonly path: string;
  readonly relsPath: string;
  readonly rels: readonly Relationship[];
}

export interface XlsxPackage {
  readonly archive: ZipArchive;
  readonly workbookPath: string;
  readonly workbookRelsPath: string;
  readonly workbookRels: readonly Relationship[];
  /** ワークシートだけ（グラフシートは含めない）。 */
  readonly sheets: readonly SheetPart[];
  /** 部品を展開して読む。無ければ null。 */
  read(path: string): Uint8Array | null;
  has(path: string): boolean;
}

export function openPackage(bytes: Uint8Array, inflate: Inflater, limits: ExcelLimits = DEFAULT_LIMITS): XlsxPackage | null {
  const zip = openZip(bytes);
  if (!zip.ok) return null;
  const archive = zip.archive;
  let used = 0;
  const read = (path: string): Uint8Array | null => {
    const entry = archive.entries.get(path.toLowerCase());
    if (entry === undefined) return null;
    const budget = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - used);
    if (budget <= 0) return null;
    const r = readZipEntry(archive, entry, inflate, budget);
    if (!r.ok) return null;
    used += r.data.length;
    return r.data;
  };

  let workbookPath = 'xl/workbook.xml';
  const root = read('_rels/.rels');
  if (root !== null) {
    const office = parseRels(root, '').find((r) => r.type === 'officeDocument' && r.target !== null);
    if (office?.target != null) workbookPath = office.target;
  }
  const wb = read(workbookPath);
  if (wb === null) return null;
  const workbookRelsPath = relsPathOf(workbookPath);
  const relsBytes = read(workbookRelsPath);
  const workbookRels = relsBytes === null ? [] : parseRels(relsBytes, workbookPath);
  const relById = new Map(workbookRels.map((r) => [r.id, r]));

  const sheets: SheetPart[] = [];
  const x = new XmlScanner(wb);
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k !== XML_START || !x.nameIs('sheet')) continue;
    const name = x.attr('name');
    const id = x.attr('id');
    if (name === null || id === null) continue;
    const rel = relById.get(id);
    if (rel?.type !== 'worksheet' || rel.target === null) continue;
    const relsPath = relsPathOf(rel.target);
    const sheetRels = read(relsPath);
    sheets.push({ name, path: rel.target, relsPath, rels: sheetRels === null ? [] : parseRels(sheetRels, rel.target) });
  }

  return {
    archive,
    workbookPath,
    workbookRelsPath,
    workbookRels,
    sheets,
    read,
    has: (path) => archive.entries.has(path.toLowerCase()),
  };
}

/**
 * 行の挿入・削除をしてもずらし方が分かっている関係（docs/07 5.3）。これ以外の関係を持つシートの行は動かさない。
 * hyperlink（外部リンクの宛先）・printerSettings・image（背景）は行の位置を持たない。
 */
export const ROW_SAFE_RELATIONS: ReadonlySet<string> = new Set([
  'table',
  'drawing',
  'comments',
  'vmlDrawing',
  'threadedComment',
  'hyperlink',
  'printerSettings',
  'image',
]);

export interface TableHeader {
  /** 見出しの行（0 始まり）と列の範囲。 */
  readonly row: number;
  readonly c1: number;
  readonly c2: number;
}

/** 範囲（0 始まり・両端を含む）。 */
export interface CellBox {
  readonly r1: number;
  readonly c1: number;
  readonly r2: number;
  readonly c2: number;
}

export interface SheetInspection {
  readonly name: string;
  /** 行をずらし方が分からない関係（空なら行の挿入・削除ができる）。 */
  readonly unsafeRelations: readonly string[];
  readonly tableHeaders: readonly TableHeader[];
  /** 配列数式・データテーブルの範囲。 */
  readonly arrayRanges: readonly CellBox[];
}

/** 書き換えの可否を判断するための、シートごとの様子。名前は小文字で引く。 */
export function inspectXlsx(bytes: Uint8Array, inflate: Inflater): Map<string, SheetInspection> | null {
  const pkg = openPackage(bytes, inflate);
  if (pkg === null) return null;
  const out = new Map<string, SheetInspection>();
  for (const sheet of pkg.sheets) {
    const unsafeRelations = sheet.rels.filter((r) => !ROW_SAFE_RELATIONS.has(r.type)).map((r) => r.type);
    const tableHeaders: TableHeader[] = [];
    for (const rel of sheet.rels) {
      if (rel.type !== 'table' || rel.target === null) continue;
      const table = pkg.read(rel.target);
      if (table === null) continue;
      const x = new XmlScanner(table);
      for (let k = x.next(); k !== XML_EOF; k = x.next()) {
        if (k !== XML_START || !x.nameIs('table')) continue;
        const ref = x.attr('ref');
        const range = ref === null ? null : parseRange(ref);
        if (range !== null && x.attrInt('headerRowCount', 1) !== 0) {
          tableHeaders.push({ row: range.r1, c1: range.c1, c2: range.c2 });
        }
        break;
      }
    }
    const arrayRanges: CellBox[] = [];
    const xml = pkg.read(sheet.path);
    if (xml !== null) {
      const x = new XmlScanner(xml);
      for (let k = x.next(); k !== XML_EOF; k = x.next()) {
        if (k !== XML_START || !x.nameIs('f')) continue;
        const t = x.attr('t');
        if (t !== 'array' && t !== 'dataTable') continue;
        const ref = x.attr('ref');
        const range = ref === null ? null : parseRange(ref);
        if (range !== null) arrayRanges.push({ r1: range.r1, c1: range.c1, r2: range.r2, c2: range.c2 });
      }
    }
    out.set(sheet.name.toLowerCase(), { name: sheet.name, unsafeRelations, tableHeaders, arrayRanges });
  }
  return out;
}
