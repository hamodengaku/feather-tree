import { describe, expect, it } from 'vitest';
import { CHANNELS, fail, ok } from '../src/index.js';

describe('IPC 契約', () => {
  it('Result のヘルパが判別可能な形を返す', () => {
    const good = ok(1);
    const bad = fail({ kind: 'internal', message: 'x' });
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
  });

  it('チャネル名が重複していない', () => {
    const names = Object.values(CHANNELS);
    expect(new Set(names).size).toBe(names.length);
  });
});
