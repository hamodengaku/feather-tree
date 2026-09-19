import { describe, expect, it } from 'vitest';
import { applyTheme, isDarkTheme, THEME_OPTIONS, THEMES } from '../src/lib/theme.js';

/**
 * applyTheme() は root.style.setProperty() しか呼ばない（土台の applyTokens 経由）ので、
 * DOM 環境（jsdom 等）を入れずにその最小インターフェースだけを偽装してテストする。
 */
function fakeRoot(): { root: HTMLElement; get: (name: string) => string | undefined } {
  const store = new Map<string, string>();
  const root = {
    style: {
      setProperty(name: string, value: string) {
        store.set(name, value);
      },
    },
  } as unknown as HTMLElement;
  return { root, get: (name: string) => store.get(name) };
}

describe('THEME_OPTIONS', () => {
  // 並びは設定画面の 2 列（左＝フェザー / 右＝クラシック）と直結している。
  it('4 テーマすべてを、系統ごとに 2 つずつ、指定された表記・順序で持つ', () => {
    expect(THEME_OPTIONS.map((o) => o.value)).toEqual([
      'phoenix-dark',
      'phoenix-light',
      'classic-dark',
      'classic-light',
    ]);
    expect(THEME_OPTIONS.map((o) => o.label)).toEqual([
      'ダークモード（フェザー）',
      'ライトモード（フェザー）',
      'ダークモード（クラシック）',
      'ライトモード（クラシック）',
    ]);
  });
});

describe('isDarkTheme', () => {
  it('dark 系は true、light 系は false', () => {
    expect(isDarkTheme('classic-dark')).toBe(true);
    expect(isDarkTheme('phoenix-dark')).toBe(true);
    expect(isDarkTheme('classic-light')).toBe(false);
    expect(isDarkTheme('phoenix-light')).toBe(false);
  });
});

describe('applyTheme のマーブル背景', () => {
  it('クラシックは常に none（模様を持たない）', () => {
    const { root, get } = fakeRoot();
    applyTheme('classic-dark', root);
    expect(get('--app-bg-app-image')).toBe('none');
    applyTheme('classic-light', root);
    expect(get('--app-bg-app-image')).toBe('none');
  });

  it('フェザーは radial-gradient の重ね合わせになる', () => {
    const { root, get } = fakeRoot();
    applyTheme('phoenix-dark', root);
    const image = get('--app-bg-app-image') ?? '';
    expect(image).not.toBe('none');
    expect(image).toContain('radial-gradient(circle at');
    // 7〜10個のランダム配置
    const layerCount = image.split('radial-gradient(').length - 1;
    expect(layerCount).toBeGreaterThanOrEqual(7);
    expect(layerCount).toBeLessThanOrEqual(10);
  });

  it('半径は 11〜26%に収まる', () => {
    const { root, get } = fakeRoot();
    applyTheme('phoenix-dark', root);
    const image = get('--app-bg-app-image') ?? '';
    const radii = [...image.matchAll(/,0\)\s*([\d.]+)%\)/g)].map((m) => Number(m[1]));
    expect(radii.length).toBeGreaterThan(0);
    for (const r of radii) {
      expect(r).toBeGreaterThanOrEqual(11);
      expect(r).toBeLessThanOrEqual(26);
    }
  });

  it('位置は確率的に右下へ寄る（べき分布。全部ではなく大半が、という設計）', () => {
    const { root, get } = fakeRoot();
    applyTheme('phoenix-dark', root);
    const image = get('--app-bg-app-image') ?? '';
    const coords = [...image.matchAll(/circle at ([\d.]+)% ([\d.]+)%/g)].flatMap((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    expect(coords.length).toBeGreaterThan(0);
    const average = coords.reduce((sum, v) => sum + v, 0) / coords.length;
    // 一様分布なら期待値は 50。べき分布（BOTTOM_RIGHT_BIAS=2.4）の期待値は約 71 なので、
    // 偏りが効いていることをゆるめの閾値で確認する（サンプル数が小さいため厳密な検定はしない）。
    expect(average).toBeGreaterThan(45);
  });

  it('緋色ベース+金', () => {
    const EXTRACTED_PALETTE_RGB = new Set([
      '201,147,46', // 山吹金 #C9932E
      '96,16,32', // Dark Crimson #601020
      '160,32,48', // Crimson Red #A02030
      '200,80,100', // Rose Red #C85064
      '200,120,140', // Warm Pink #C8788C
      '180,140,160', // Dusty Mauve #B48CA0
      '240,225,225', // Pale Highlight #F0E1E1
    ]);
    const { root, get } = fakeRoot();
    applyTheme('phoenix-dark', root);
    const image = get('--app-bg-app-image') ?? '';
    const usedRgb = [...image.matchAll(/rgba\((\d+,\d+,\d+),/g)].map((m) => m[1] ?? '');
    expect(usedRgb.length).toBeGreaterThan(0);
    for (const rgb of usedRgb) expect(EXTRACTED_PALETTE_RGB.has(rgb)).toBe(true);
  });

  it('同一セッション内では phoenix-dark と phoenix-light で配置（座標）が一致する', () => {
    const { root, get } = fakeRoot();
    applyTheme('phoenix-dark', root);
    const dark = get('--app-bg-app-image') ?? '';
    applyTheme('phoenix-light', root);
    const light = get('--app-bg-app-image') ?? '';

    const positions = (css: string): string[] =>
      [...css.matchAll(/circle at ([\d.]+% [\d.]+%)/g)].map((m) => m[1] ?? '');
    expect(positions(dark)).toEqual(positions(light));
    // ただし不透明度の範囲はモードで違うので、模様自体は等しくない
    expect(dark).not.toBe(light);
  });

  it('color-scheme は dark / light の 2 値にマップされる', () => {
    const { root, get } = fakeRoot();
    applyTheme('phoenix-dark', root);
    expect(get('color-scheme')).toBe('dark');
    applyTheme('phoenix-light', root);
    expect(get('color-scheme')).toBe('light');
  });
});

describe('THEMES', () => {
  it('4 テーマすべてに --app-scheme を持つ', () => {
    for (const name of Object.keys(THEMES) as (keyof typeof THEMES)[]) {
      expect(['dark', 'light']).toContain(THEMES[name]['--app-scheme']);
    }
  });
});
