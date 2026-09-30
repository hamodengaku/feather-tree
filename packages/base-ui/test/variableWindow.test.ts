import { describe, expect, it } from 'vitest';
import { buildOffsets, indexAtOffset, rangeAtOffset } from '../src/index.js';

describe('可変サイズの仮想化', () => {
  it('累積和は長さ n + 1 で、負の大きさは 0 とみなす', () => {
    expect([...buildOffsets([10, 20, -5, 30])]).toEqual([0, 10, 30, 30, 60]);
    expect([...buildOffsets([])]).toEqual([0]);
  });

  it('位置を含む要素を引く。大きさ 0 の要素は飛ばす', () => {
    const o = buildOffsets([10, 20, 0, 30]);
    expect(indexAtOffset(o, 0)).toBe(0);
    expect(indexAtOffset(o, 9)).toBe(0);
    expect(indexAtOffset(o, 10)).toBe(1);
    expect(indexAtOffset(o, 29)).toBe(1);
    // 30 には大きさ 0 の要素 2 と要素 3 が重なっている。見えるのは 3
    expect(indexAtOffset(o, 30)).toBe(3);
    expect(indexAtOffset(o, 999)).toBe(3);
    expect(indexAtOffset(buildOffsets([]), 5)).toBe(0);
  });

  it('見えている範囲に前後の余白を足す', () => {
    const o = buildOffsets(Array.from({ length: 100 }, () => 20));
    expect(rangeAtOffset(o, 0, 100, 0)).toEqual({ start: 0, end: 5, total: 2000 });
    expect(rangeAtOffset(o, 205, 100, 2)).toEqual({ start: 8, end: 18, total: 2000 });
    expect(rangeAtOffset(o, 1990, 100, 2).end).toBe(100);
    expect(rangeAtOffset(buildOffsets([]), 0, 100)).toEqual({ start: 0, end: 0, total: 0 });
  });
});
