/**
 * canvas による文字幅の実測。同じ文字列は測り直さない。
 *
 * 土台としての意図: 横スクロールの幅を決めるために、画面外の行も含めて
 * 数千〜数万件を測ることがある。呼ぶ側が毎回 canvas を作らずに済むようにする。
 *
 * フォントが変わった（テーマ切替など）ら、キャッシュは丸ごと捨てる。
 */
export interface TextMeasurer {
  /** font は getComputedStyle(el).font の値をそのまま渡す。 */
  width(text: string, font: string): number;
}

export function createTextMeasurer(): TextMeasurer {
  let canvas: HTMLCanvasElement | null = null;
  let cache = new Map<string, number>();
  let cachedFont = '';

  return {
    width(text: string, font: string): number {
      if (font !== cachedFont) {
        cache = new Map();
        cachedFont = font;
      }
      const hit = cache.get(text);
      if (hit !== undefined) return hit;

      canvas ??= document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (ctx === null) return 0;
      ctx.font = font;
      const w = ctx.measureText(text).width;
      cache.set(text, w);
      return w;
    },
  };
}
