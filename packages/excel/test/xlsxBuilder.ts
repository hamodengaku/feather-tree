/*
 * テスト用の最小の xlsx を組み立てる。
 *
 * シートを宣言すると、[Content_Types].xml・rels・workbook.xml・sharedStrings.xml・worksheet を
 * 作って ZIP（stored）にする。Excel が書くものより素朴だが、読み取り側が頼る部品は揃っている。
 * 実 Excel で保存したファイルでの確認は手動検証で行う（docs/03 Phase 13）。
 */

import { buildZip, type ZipInput, type ZipOptions } from './zipBuilder.js';

/** セルの宣言。 */
export type CellSpec =
  | null
  | string
  | number
  | boolean
  | { readonly f: string; readonly v?: number | string; readonly t?: 'shared' | 'array'; readonly si?: number; readonly ref?: string }
  | { readonly fs: number } // 共有数式の従属セル（si だけ）
  | { readonly inline: string }
  | { readonly error: string }
  | { readonly style: number }; // 値の無い書式だけのセル

export interface SheetSpec {
  readonly name: string;
  readonly sheetId?: number;
  readonly state?: 'hidden' | 'veryHidden';
  readonly rows?: readonly (readonly CellSpec[])[];
  /** worksheet の XML をそのまま使う。 */
  readonly xml?: string;
  readonly merges?: readonly string[];
  readonly cols?: string;
  readonly hiddenRows?: readonly number[];
  readonly rowHeights?: Readonly<Record<number, number>>;
  readonly chart?: boolean;
}

export interface BookSpec {
  readonly sheets: readonly SheetSpec[];
  readonly date1904?: boolean;
  /** 文字列を sharedStrings にせずインラインで書く。 */
  readonly inlineStrings?: boolean;
  /** 部品を差し替える・足す。 */
  readonly extraParts?: readonly ZipInput[];
  /** 省く部品（ZIP 内のパス）。 */
  readonly omit?: readonly string[];
  readonly vba?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function colName(c: number): string {
  let n = c + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function sheetXml(spec: SheetSpec, sst: string[], inline: boolean): string {
  const index = new Map<string, number>(sst.map((s, i) => [s, i]));
  const str = (s: string): number => {
    let i = index.get(s);
    if (i === undefined) {
      i = sst.length;
      sst.push(s);
      index.set(s, i);
    }
    return i;
  };

  const rows = (spec.rows ?? []).map((cells, r) => {
    const attrs: string[] = [`r="${String(r + 1)}"`];
    const ht = spec.rowHeights?.[r];
    if (ht !== undefined) attrs.push(`ht="${String(ht)}" customHeight="1"`);
    if (spec.hiddenRows?.includes(r) === true) attrs.push('hidden="1"');
    const body = cells
      .map((cell, c) => {
        if (cell === null) return '';
        const ref = colName(c) + String(r + 1);
        if (typeof cell === 'string') {
          return inline
            ? `<c r="${ref}" t="inlineStr"><is><t>${esc(cell)}</t></is></c>`
            : `<c r="${ref}" t="s"><v>${String(str(cell))}</v></c>`;
        }
        if (typeof cell === 'number') return `<c r="${ref}"><v>${String(cell)}</v></c>`;
        if (typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${cell ? '1' : '0'}</v></c>`;
        if ('fs' in cell) return `<c r="${ref}"><f t="shared" si="${String(cell.fs)}"/></c>`;
        if ('inline' in cell) return `<c r="${ref}" t="inlineStr"><is><t>${esc(cell.inline)}</t></is></c>`;
        if ('error' in cell) return `<c r="${ref}" t="e"><v>${esc(cell.error)}</v></c>`;
        if ('style' in cell) return `<c r="${ref}" s="${String(cell.style)}"/>`;
        const fAttrs =
          cell.t === 'shared'
            ? ` t="shared" si="${String(cell.si ?? 0)}"${cell.ref !== undefined ? ` ref="${cell.ref}"` : ''}`
            : cell.t === 'array'
              ? ` t="array" ref="${cell.ref ?? ref}"`
              : '';
        const tAttr = typeof cell.v === 'string' ? ' t="str"' : '';
        const v = cell.v === undefined ? '' : `<v>${esc(String(cell.v))}</v>`;
        return `<c r="${ref}"${tAttr}><f${fAttrs}>${esc(cell.f)}</f>${v}</c>`;
      })
      .join('');
    return `<row ${attrs.join(' ')}>${body}</row>`;
  });

  const merges =
    spec.merges !== undefined && spec.merges.length > 0
      ? `<mergeCells count="${String(spec.merges.length)}">${spec.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
      : '';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (spec.cols ?? '') +
    `<sheetData>${rows.join('')}</sheetData>` +
    merges +
    '</worksheet>'
  );
}

export function buildXlsx(book: BookSpec, options: ZipOptions = {}): Uint8Array {
  const sst: string[] = [];
  const inline = book.inlineStrings === true;
  const parts: ZipInput[] = [];
  const sheetEntries: string[] = [];
  const relEntries: string[] = [];

  book.sheets.forEach((spec, i) => {
    const n = i + 1;
    const id = spec.sheetId ?? n;
    const state = spec.state !== undefined ? ` state="${spec.state}"` : '';
    sheetEntries.push(`<sheet name="${esc(spec.name)}" sheetId="${String(id)}"${state} r:id="rId${String(n)}"/>`);
    if (spec.chart === true) {
      relEntries.push(
        `<Relationship Id="rId${String(n)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet${String(n)}.xml"/>`,
      );
      parts.push({ name: `xl/chartsheets/sheet${String(n)}.xml`, data: '<chartsheet/>' });
      return;
    }
    relEntries.push(
      `<Relationship Id="rId${String(n)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(n)}.xml"/>`,
    );
    parts.push({ name: `xl/worksheets/sheet${String(n)}.xml`, data: spec.xml ?? sheetXml(spec, sst, inline) });
  });

  relEntries.push(
    '<Relationship Id="rIdSst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>',
  );

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    (book.date1904 === true ? '<workbookPr date1904="1"/>' : '<workbookPr/>') +
    `<sheets>${sheetEntries.join('')}</sheets></workbook>`;

  const sstXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${String(sst.length)}" uniqueCount="${String(sst.length)}">` +
    sst.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') +
    '</sst>';

  const all: ZipInput[] = [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    { name: 'xl/workbook.xml', data: workbook },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        relEntries.join('') +
        '</Relationships>',
    },
    { name: 'xl/sharedStrings.xml', data: sstXml },
    ...parts,
    ...(book.vba !== undefined ? [{ name: 'xl/vbaProject.bin', data: book.vba }] : []),
  ];

  const replaced = new Map((book.extraParts ?? []).map((p) => [p.name, p]));
  const merged = all.map((p) => replaced.get(p.name) ?? p);
  for (const p of book.extraParts ?? []) if (!all.some((q) => q.name === p.name)) merged.push(p);
  const omit = new Set(book.omit ?? []);
  return buildZip(merged.filter((p) => !omit.has(p.name)), options);
}
