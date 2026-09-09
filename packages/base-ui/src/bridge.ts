/**
 * preload が公開したブリッジへの遅延アクセス。
 *
 * 土台としての意図: 読み込み時点では `window` を参照しない。
 * こうしておくと、状態クラスにブリッジを注入する形にできるので、
 * **ブラウザ環境なしで（偽のブリッジで）テストできる**。
 */
interface MaybeWindow<T> {
  window?: Record<string, T | undefined>;
}

export function createBridgeProxy<T extends object>(globalKey: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const real = (globalThis as unknown as MaybeWindow<T>).window?.[globalKey];
      if (real === undefined) {
        throw new Error(`preload の橋 (window.${globalKey}) が利用できません`);
      }
      return Reflect.get(real, property, real);
    },
  });
}
