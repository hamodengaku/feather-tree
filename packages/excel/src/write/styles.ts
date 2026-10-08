/*
 * 相手側の書式を土台の styles.xml へ足し込む（docs/07-xlsx-cell-merge.md 4.2）。
 *
 * 相手側のセルの `s` は相手側の `cellXfs` の添字なので、そのまま写すと別の書式を指す。
 * 相手側の `<xf>` が指す font / fill / border / numFmt を土台に探し（**要素の XML の文字列が同じもの**）、
 * 無ければ土台の一覧の末尾へ足して、付け替えた `<xf>` を土台の `cellXfs` へ足す（同じものがあれば使い回す）。
 * `xfId`（セルのスタイル）は 0 にする。
 *
 * 書き換えは一覧の末尾への追加と `count` の付け替えだけ。既存の添字は動かないので、土台の他のセルは影響を受けない。
 */

import { decodeUtf8 } from '../text/utf8.js';
import { XML_END, XML_EOF, XML_START, XmlScanner } from '../xml/scanner.js';
import { ByteEdits, escapeXmlAttr, utf8 } from './edits.js';

/** 書式の部品が足りず、持ち込めない。 */
export class StyleImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StyleImportError';
  }
}

type ListName = 'numFmts' | 'fonts' | 'fills' | 'borders' | 'cellXfs';
const LISTS: readonly ListName[] = ['numFmts', 'fonts', 'fills', 'borders', 'cellXfs'];

interface StyleList {
  readonly items: string[];
  /** 開始タグの範囲。無ければ null。 */
  readonly startTag: readonly [number, number] | null;
  readonly selfClosing: boolean;
  /** 終了タグの位置（足す要素はここへ入れる）。 */
  readonly closeAt: number;
  /** `count` 属性の値の範囲。無ければ null。 */
  readonly count: readonly [number, number] | null;
}

interface ParsedStyles {
  readonly lists: Map<ListName, StyleList>;
}

function parseStyleLists(bytes: Uint8Array): ParsedStyles {
  const x = new XmlScanner(bytes);
  const lists = new Map<ListName, StyleList>();
  let depth = 0;
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k === XML_END) {
      depth -= 1;
      continue;
    }
    if (k !== XML_START) continue;
    const name = LISTS.find((n) => x.nameIs(n));
    if (depth !== 1 || name === undefined) {
      if (!x.selfClosing) depth += 1;
      continue;
    }
    const startTag: [number, number] = [x.tokenStart, x.tokenEnd];
    const count: [number, number] | null = x.attrRaw('count') ? [x.valueStart, x.valueEnd] : null;
    if (x.selfClosing) {
      lists.set(name, { items: [], startTag, selfClosing: true, closeAt: x.tokenEnd, count });
      continue;
    }
    const items: string[] = [];
    let closeAt = bytes.length;
    for (let c = x.next(); c !== XML_EOF; c = x.next()) {
      if (c === XML_END) {
        closeAt = x.tokenStart;
        break;
      }
      if (c !== XML_START) continue;
      const start = x.tokenStart;
      x.skipElement();
      items.push(decodeUtf8(bytes, start, x.position));
    }
    lists.set(name, { items, startTag, selfClosing: false, closeAt, count });
  }
  return { lists };
}

/** 要素の文字列から属性の値を読む（開始タグだけを見る）。 */
function attrOf(element: string, name: string): string | null {
  const x = new XmlScanner(utf8(element));
  if (x.next() !== XML_START) return null;
  return x.attr(name);
}

/** 開始タグの属性を置き換える（無ければ足す）。 */
function setAttrs(element: string, values: Readonly<Record<string, string>>): string {
  const bytes = utf8(element);
  const x = new XmlScanner(bytes);
  if (x.next() !== XML_START) return element;
  const edits = new ByteEdits();
  const tagEnd = x.tokenEnd - (x.selfClosing ? 2 : 1);
  for (const [name, value] of Object.entries(values)) {
    if (x.attrRaw(name)) edits.replace(x.valueStart, x.valueEnd, escapeXmlAttr(value));
    else edits.insert(tagEnd, ` ${name}="${escapeXmlAttr(value)}"`);
  }
  const out = edits.apply(bytes);
  return decodeUtf8(out, 0, out.length);
}

/** 組み込みの表示形式の番号の上限（164 以上がユーザー定義）。 */
const FIRST_CUSTOM_NUMFMT = 164;

export class StyleImporter {
  readonly #ours: Uint8Array | null;
  readonly #oursLists: Map<ListName, StyleList>;
  readonly #theirsLists: Map<ListName, StyleList>;
  /** 土台の一覧（足したものを含む）。 */
  readonly #items = new Map<ListName, string[]>();
  readonly #added = new Map<ListName, string[]>();
  readonly #cache = new Map<number, number>();
  readonly #theirsNumFmts = new Map<number, string>();

  constructor(ours: Uint8Array | null, theirs: Uint8Array | null) {
    this.#ours = ours;
    this.#oursLists = ours === null ? new Map() : parseStyleLists(ours).lists;
    this.#theirsLists = theirs === null ? new Map() : parseStyleLists(theirs).lists;
    for (const name of LISTS) {
      this.#items.set(name, [...(this.#oursLists.get(name)?.items ?? [])]);
      this.#added.set(name, []);
    }
    for (const raw of this.#theirsLists.get('numFmts')?.items ?? []) {
      const id = Number(attrOf(raw, 'numFmtId'));
      const code = attrOf(raw, 'formatCode');
      if (Number.isInteger(id) && code !== null) this.#theirsNumFmts.set(id, code);
    }
  }

  /** 相手側の cellXfs の添字 → 土台の添字。 */
  importXf(theirsIndex: number): number {
    const cached = this.#cache.get(theirsIndex);
    if (cached !== undefined) return cached;
    const theirsXfs = this.#theirsLists.get('cellXfs')?.items ?? [];
    const xf = theirsXfs[theirsIndex] ?? theirsXfs[0];
    if (xf === undefined) {
      // 相手側に書式の部品が無い: 既定の書式（0）
      this.#cache.set(theirsIndex, 0);
      return 0;
    }
    if (this.#ours === null || !this.#oursLists.has('cellXfs')) {
      throw new StyleImportError('土台のブックに書式の部品（styles.xml）が無いため、相手側の書式を持ち込めません。');
    }
    const font = this.#importItem('fonts', Number(attrOf(xf, 'fontId') ?? '0'));
    const fill = this.#importItem('fills', Number(attrOf(xf, 'fillId') ?? '0'));
    const border = this.#importItem('borders', Number(attrOf(xf, 'borderId') ?? '0'));
    const numFmt = this.#importNumFmt(Number(attrOf(xf, 'numFmtId') ?? '0'));
    const rewritten = setAttrs(xf, {
      numFmtId: String(numFmt),
      fontId: String(font),
      fillId: String(fill),
      borderId: String(border),
      xfId: '0',
    });
    const index = this.#findOrAdd('cellXfs', rewritten);
    this.#cache.set(theirsIndex, index);
    return index;
  }

  /** 足したものがあれば、書き換えた styles.xml。無ければ null。 */
  result(): Uint8Array | null {
    const ours = this.#ours;
    if (ours === null) return null;
    if (LISTS.every((n) => (this.#added.get(n)?.length ?? 0) === 0)) return null;
    const edits = new ByteEdits();
    for (const name of LISTS) {
      const added = this.#added.get(name) ?? [];
      if (added.length === 0) continue;
      const total = String(this.#items.get(name)?.length ?? 0);
      const list = this.#oursLists.get(name);
      if (list === undefined || list.startTag === null) {
        // 一覧ごと無い（numFmts は無いのが普通）。fonts の前に置く（styles.xml の要素の順）
        const fonts = this.#oursLists.get('fonts');
        if (name !== 'numFmts' || fonts?.startTag == null) {
          throw new StyleImportError('土台の書式の部品の形が想定と違うため、相手側の書式を持ち込めません。');
        }
        edits.insert(fonts.startTag[0], `<numFmts count="${total}">${added.join('')}</numFmts>`);
        continue;
      }
      if (list.selfClosing) {
        const tag = decodeUtf8(ours, list.startTag[0], list.startTag[1]);
        const open = setAttrs(tag, { count: total }).replace(/\s*\/>$/, '>');
        edits.replace(list.startTag[0], list.startTag[1], `${open}${added.join('')}</${name}>`);
        continue;
      }
      edits.insert(list.closeAt, added.join(''));
      if (list.count !== null) edits.replace(list.count[0], list.count[1], total);
      else edits.insert(list.startTag[1] - 1, ` count="${total}"`);
    }
    return edits.apply(ours);
  }

  #importItem(name: 'fonts' | 'fills' | 'borders', theirsIndex: number): number {
    const raw = this.#theirsLists.get(name)?.items[Number.isInteger(theirsIndex) ? theirsIndex : 0];
    if (raw === undefined) return 0;
    return this.#findOrAdd(name, raw);
  }

  #importNumFmt(id: number): number {
    if (!Number.isInteger(id) || id < FIRST_CUSTOM_NUMFMT) return Number.isInteger(id) ? id : 0;
    const code = this.#theirsNumFmts.get(id);
    if (code === undefined) return 0;
    const items = this.#items.get('numFmts') ?? [];
    let maxId = FIRST_CUSTOM_NUMFMT - 1;
    for (const raw of items) {
      const oursId = Number(attrOf(raw, 'numFmtId'));
      if (attrOf(raw, 'formatCode') === code && Number.isInteger(oursId)) return oursId;
      if (Number.isInteger(oursId)) maxId = Math.max(maxId, oursId);
    }
    const newId = maxId + 1;
    this.#push('numFmts', `<numFmt numFmtId="${String(newId)}" formatCode="${escapeXmlAttr(code)}"/>`);
    return newId;
  }

  #findOrAdd(name: ListName, raw: string): number {
    const items = this.#items.get(name) ?? [];
    const found = items.indexOf(raw);
    if (found >= 0) return found;
    return this.#push(name, raw);
  }

  #push(name: ListName, raw: string): number {
    const items = this.#items.get(name) ?? [];
    items.push(raw);
    this.#items.set(name, items);
    this.#added.get(name)?.push(raw);
    return items.length - 1;
  }
}
