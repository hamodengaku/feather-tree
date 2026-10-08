/*
 * バイト範囲の置き換え（決定 34 の第 2 段階）。
 *
 * XML は文字列に組み直さず、**変える所だけを元のバイト列の上で置き換える**。読んでいない要素・属性
 * （拡張の名前空間など）はそのまま残る。置き換えは重なってはならない（重なったら作り手の不具合なので投げる）。
 */

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** 要素の中身の文字（`<` `&` `>` を逃がす）。 */
export function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 属性値（引用符 `"` も逃がす）。 */
export function escapeXmlAttr(text: string): string {
  return escapeXmlText(text).replace(/"/g, '&quot;');
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly bytes: Uint8Array;
}

export class ByteEdits {
  readonly #edits: Edit[] = [];

  get size(): number {
    return this.#edits.length;
  }

  /** [start, end) を replacement に置き換える。start === end なら挿入。 */
  replace(start: number, end: number, replacement: string | Uint8Array): void {
    this.#edits.push({ start, end, bytes: typeof replacement === 'string' ? utf8(replacement) : replacement });
  }

  insert(at: number, text: string | Uint8Array): void {
    this.replace(at, at, text);
  }

  remove(start: number, end: number): void {
    this.replace(start, end, new Uint8Array(0));
  }

  apply(source: Uint8Array): Uint8Array {
    if (this.#edits.length === 0) return source;
    // 同じ位置への挿入は登録した順を保つ（安定な並べ替え）
    const edits = this.#edits.map((e, i) => ({ e, i })).sort((a, b) => a.e.start - b.e.start || a.e.end - b.e.end || a.i - b.i);
    const parts: Uint8Array[] = [];
    let at = 0;
    let total = 0;
    for (const { e } of edits) {
      if (e.start < at || e.end < e.start || e.end > source.length) {
        throw new Error('ByteEdits: 置き換えの範囲が重なっています');
      }
      parts.push(source.subarray(at, e.start), e.bytes);
      total += e.start - at + e.bytes.length;
      at = e.end;
    }
    parts.push(source.subarray(at));
    total += source.length - at;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}
