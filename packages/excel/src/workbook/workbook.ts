/*
 * ブックを開く（決定 33）。
 *
 *   1. 先頭のバイトで形式を見分ける（CFB・LFS ポインタはここで終わり）
 *   2. ZIP の目次を読む
 *   3. `_rels/.rels` からブック本体の部品を引く（無ければ `xl/workbook.xml`）。`.bin` なら `.xlsb` で対象外
 *   4. ブック本体からシートの一覧、ブックの rels から各シート・共有文字列の部品を引く
 *   5. シートを 1 枚ずつ読む
 *
 * **シート 1 枚ごとに区切れる形（ジェネレータ）にしてある。** 呼び出し側（core）は 1 枚読むたびに
 * イベントループへ制御を返し、中止を確かめられる。このパッケージは Node を知らないので、
 * 「どう譲るか」は呼び出し側が決める。同期でまとめて読みたいときは `openWorkbook` を使う。
 */

import { DEFAULT_LIMITS, type ExcelLimits } from '../limits.js';
import type { OpenFailure, OpenResult, SheetInfo, SheetKind, SheetState, Workbook } from '../model/types.js';
import { parseRels, relsPathOf, type Relationship } from '../opc/rels.js';
import { parseWorksheet } from '../sheet/worksheet.js';
import { sniffExcel } from '../sniff.js';
import { XML_EOF, XML_START, XmlScanner } from '../xml/scanner.js';
import { openZip, readZipEntry, type Inflater, type ZipArchive } from '../zip/reader.js';
import { parseSharedStrings } from './sst.js';
import { parseStyles, type StyleTable } from '../style/styles.js';
import { parseTheme } from '../style/theme.js';
import { DEFAULT_THEME } from '../style/colors.js';

interface SheetEntry {
  readonly name: string;
  readonly sheetId: number;
  readonly state: SheetState;
  readonly relId: string;
}

/** 1 シート読むごとに 1 回 yield し、最後に結果を返す。 */
export function* openWorkbookSteps(
  bytes: Uint8Array,
  inflate: Inflater,
  limits: ExcelLimits = DEFAULT_LIMITS,
): Generator<void, OpenResult> {
  const failed = (reason: OpenFailure): OpenResult => ({ ok: false, reason });

  if (bytes.length > limits.maxFileBytes) return failed('too-large');
  switch (sniffExcel(bytes)) {
    case 'empty':
      return failed('empty');
    case 'cfb':
      return failed('encrypted-or-legacy');
    case 'lfs-pointer':
      return failed('lfs-pointer');
    case 'unknown':
      return failed('not-zip');
    default:
      break;
  }

  const zip = openZip(bytes);
  if (!zip.ok) return failed(zip.reason);
  const reader = new PartReader(zip.archive, inflate, limits);

  // ブック本体の部品
  let workbookPath = 'xl/workbook.xml';
  const rootRels = reader.read('_rels/.rels');
  if (rootRels.kind === 'ok') {
    const office = parseRels(rootRels.data, '').find((r) => r.type === 'officeDocument' && r.target !== null);
    if (office?.target != null) workbookPath = office.target;
  } else if (rootRels.kind === 'too-large') {
    return failed('too-large');
  }
  if (workbookPath.toLowerCase().endsWith('.bin')) return failed('not-spreadsheet');

  const wb = reader.read(workbookPath);
  if (wb.kind === 'missing') return failed('not-spreadsheet');
  if (wb.kind === 'too-large') return failed('too-large');
  if (wb.kind !== 'ok') return failed('broken');

  const { sheets: entries, date1904 } = parseWorkbookPart(wb.data);

  const relsFile = reader.read(relsPathOf(workbookPath));
  if (relsFile.kind === 'too-large') return failed('too-large');
  const rels = relsFile.kind === 'ok' ? parseRels(relsFile.data, workbookPath) : [];
  const relById = new Map<string, Relationship>(rels.map((r) => [r.id, r]));

  // 共有文字列（無いブックもある）
  let sst: string[] = [];
  const sstRel = rels.find((r) => r.type === 'sharedStrings' && r.target !== null);
  const sstPath = sstRel?.target ?? (reader.has('xl/sharedStrings.xml') ? 'xl/sharedStrings.xml' : null);
  if (sstPath !== null) {
    const part = reader.read(sstPath);
    if (part.kind === 'too-large') return failed('too-large');
    if (part.kind === 'ok') sst = parseSharedStrings(part.data, limits.maxSharedStrings);
  }

  // 書式（M2）。テーマの色を先に読む（styles.xml の色がテーマを指すため）。どちらも無くてよい
  let theme: readonly string[] = DEFAULT_THEME;
  const themeRel = rels.find((r) => r.type === 'theme' && r.target !== null);
  const themePart = reader.read(themeRel?.target ?? 'xl/theme/theme1.xml');
  if (themePart.kind === 'ok') theme = parseTheme(themePart.data);
  let styles: StyleTable | null = null;
  const stylesRel = rels.find((r) => r.type === 'styles' && r.target !== null);
  const stylesPart = reader.read(stylesRel?.target ?? 'xl/styles.xml');
  if (stylesPart.kind === 'too-large') return failed('too-large');
  if (stylesPart.kind === 'ok') styles = parseStyles(stylesPart.data, theme);

  const vba = zip.archive.entries.get('xl/vbaproject.bin');

  const sheets: SheetInfo[] = [];
  let cellsLeft = limits.maxCellsPerBook;
  for (const entry of entries) {
    const rel = relById.get(entry.relId);
    const kind = kindOf(rel?.type);
    const base = { name: entry.name, sheetId: entry.sheetId, state: entry.state, kind };

    if (kind !== 'worksheet') {
      sheets.push({ ...base, data: null, problem: kind === 'other' && rel === undefined ? 'missing-part' : null });
      continue;
    }
    if (cellsLeft <= 0) {
      sheets.push({ ...base, data: null, problem: 'too-large' });
      continue;
    }
    const part = rel?.target == null ? null : reader.read(rel.target);
    if (part === null || part.kind === 'missing') {
      sheets.push({ ...base, data: null, problem: 'missing-part' });
      continue;
    }
    if (part.kind !== 'ok') {
      sheets.push({ ...base, data: null, problem: part.kind === 'too-large' ? 'too-large' : 'broken' });
      continue;
    }
    const data = parseWorksheet(part.data, {
      maxCells: Math.min(limits.maxCellsPerSheet, cellsLeft),
      maxColumns: limits.maxColumns,
      maxRows: limits.maxRowsPerSheet,
    });
    cellsLeft -= data.cellCount;
    sheets.push({ ...base, data, problem: data.problem });
    yield;
  }

  const workbook: Workbook = {
    sheets,
    sst,
    date1904,
    vbaCrc: vba === undefined ? null : vba.crc32,
    styles,
  };
  return { ok: true, workbook };
}

/** まとめて同期で開く（テスト・小さいファイル用）。 */
export function openWorkbook(bytes: Uint8Array, inflate: Inflater, limits: ExcelLimits = DEFAULT_LIMITS): OpenResult {
  const steps = openWorkbookSteps(bytes, inflate, limits);
  for (;;) {
    const r = steps.next();
    if (r.done === true) return r.value;
  }
}

function kindOf(type: string | undefined): SheetKind {
  if (type === 'worksheet') return 'worksheet';
  if (type === 'chartsheet') return 'chartsheet';
  return 'other';
}

function parseWorkbookPart(bytes: Uint8Array): { sheets: SheetEntry[]; date1904: boolean } {
  const sheets: SheetEntry[] = [];
  let date1904 = false;
  const x = new XmlScanner(bytes);
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k !== XML_START) continue;
    if (x.nameIs('workbookPr')) {
      date1904 = x.attrBool('date1904', false);
    } else if (x.nameIs('sheet')) {
      const name = x.attr('name');
      const relId = x.attr('id');
      if (name === null || relId === null) continue;
      const state = x.attr('state');
      sheets.push({
        name,
        sheetId: x.attrInt('sheetId', -1),
        state: state === 'hidden' || state === 'veryHidden' ? state : 'visible',
        relId,
      });
    }
  }
  return { sheets, date1904 };
}

type PartRead =
  | { readonly kind: 'ok'; readonly data: Uint8Array }
  | { readonly kind: 'missing' | 'too-large' | 'broken' };

/** 部品の読み出しと、ブック全体の展開予算。 */
class PartReader {
  readonly #archive: ZipArchive;
  readonly #inflate: Inflater;
  readonly #limits: ExcelLimits;
  #used = 0;

  constructor(archive: ZipArchive, inflate: Inflater, limits: ExcelLimits) {
    this.#archive = archive;
    this.#inflate = inflate;
    this.#limits = limits;
  }

  has(path: string): boolean {
    return this.#archive.entries.has(path.toLowerCase());
  }

  read(path: string): PartRead {
    const entry = this.#archive.entries.get(path.toLowerCase());
    if (entry === undefined) return { kind: 'missing' };
    const budget = Math.min(this.#limits.maxEntryBytes, this.#limits.maxTotalBytes - this.#used);
    if (budget <= 0) return { kind: 'too-large' };
    const r = readZipEntry(this.#archive, entry, this.#inflate, budget);
    if (!r.ok) return { kind: r.reason === 'too-large' ? 'too-large' : 'broken' };
    this.#used += r.data.length;
    return { kind: 'ok', data: r.data };
  }
}
