/**
 * テーマトークンの適用。
 *
 * 土台としての方針:
 *   - CSS に色・寸法のリテラルを書かず、すべて `var(--...)` を経由する
 *   - トークンは「意味」で命名する（`--app-text-added` など。`--blue-500` のような見た目名は使わない）
 *   - 適用は `style.setProperty` のみ。インライン `<style>` を注入しないので
 *     CSP を緩める必要がない（CSSOM 経由の変更は CSP の対象外）
 *
 * トークンの値そのものはアプリ固有なので、ここでは持たない。
 */
export type ThemeTokens = Readonly<Record<string, string>>;

export interface ApplyThemeOptions {
  /** 適用先。既定は documentElement。 */
  readonly root?: HTMLElement;
  /** `color-scheme` に設定する値（'dark' / 'light'）。 */
  readonly colorScheme?: string;
}

export function applyTokens(tokens: ThemeTokens, options: ApplyThemeOptions = {}): void {
  const root = options.root ?? document.documentElement;
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value);
  }
  if (options.colorScheme !== undefined) {
    root.style.setProperty('color-scheme', options.colorScheme);
  }
}
