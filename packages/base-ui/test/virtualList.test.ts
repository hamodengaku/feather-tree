import { describe, expect, it } from 'vitest';
import { computeWindow } from '../src/index.js';

/**
 * 仮想化リストの範囲計算（土台）。
 * 「1 万件でも DOM ノードを 100 個以下に保つ」がこの計算で担保される。
 */
describe('computeWindow', () => {
  const options = { rowHeight: 22 };

  it('可視範囲 + 前後バッファ分だけを返す', () => {
    const w = computeWindow(10_000, 0, 440, options);
    expect(w.startIndex).toBe(0);
    // 440 / 22 = 20 行 + overscan 8
    expect(w.endIndex).toBe(28);
    expect(w.totalHeight).toBe(10_000 * 22);
    expect(w.paddingTop).toBe(0);
  });

  it('スクロール位置に応じて窓がずれ、描画行数は一定に保たれる', () => {
    const a = computeWindow(10_000, 22 * 1000, 440, options);
    const b = computeWindow(10_000, 22 * 5000, 440, options);
    expect(a.startIndex).toBe(1000 - 8);
    expect(b.startIndex).toBe(5000 - 8);
    expect(b.paddingTop).toBe((5000 - 8) * 22);
    // 途中同士なら行数は同じ（先頭・末尾では overscan が切られるので少なくなる）
    expect(b.endIndex - b.startIndex).toBe(a.endIndex - a.startIndex);
  });

  it('先頭では前方 overscan が切られる', () => {
    const top = computeWindow(10_000, 0, 440, options);
    expect(top.startIndex).toBe(0);
    expect(top.paddingTop).toBe(0);
    // 440 / 22 = 20 行 + 後方 overscan 8
    expect(top.endIndex).toBe(28);
  });

  it('1 万件でも描画する行数は 100 未満', () => {
    const w = computeWindow(10_000, 12_345, 800, options);
    expect(w.endIndex - w.startIndex).toBeLessThan(100);
  });

  it('末尾では endIndex が総件数を超えない', () => {
    const w = computeWindow(50, 22 * 45, 440, options);
    expect(w.endIndex).toBe(50);
  });

  it('件数 0 でも壊れない', () => {
    const w = computeWindow(0, 0, 440, options);
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(0);
    expect(w.totalHeight).toBe(0);
  });

  it('負のスクロール位置・高さを安全に扱う', () => {
    const w = computeWindow(100, -50, -10, options);
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBeGreaterThanOrEqual(0);
  });

  it('overscan を指定できる', () => {
    const w = computeWindow(1000, 0, 220, { rowHeight: 22, overscan: 0 });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(10);
  });

  it('rowHeight が 0 でも 0 除算にならない', () => {
    const w = computeWindow(100, 0, 100, { rowHeight: 0 });
    expect(Number.isFinite(w.endIndex)).toBe(true);
  });
});
