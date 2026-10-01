import { describe, expect, it } from 'vitest';
import { ScrollMemory } from '../src/lib/scrollMemory.js';

describe('差分ペインのスクロール位置（別のファイルのときだけ先頭へ）', () => {
  it('同じファイルに戻ってきたら覚えていた位置へ', () => {
    const memory = new ScrollMemory();
    expect(memory.positionFor('diff:s1', 'a.txt:false')).toEqual({ top: 0, left: 0 });
    memory.record('diff:s1', 'a.txt:false', { top: 480, left: 12 });

    expect(memory.positionFor('diff:s1', 'a.txt:false')).toEqual({ top: 480, left: 12 });
  });

  it('別のファイルなら先頭へ戻し、以後はそのファイルを覚える', () => {
    const memory = new ScrollMemory();
    memory.record('diff:s1', 'a.txt:false', { top: 480, left: 0 });

    expect(memory.positionFor('diff:s1', 'b.txt:false')).toEqual({ top: 0, left: 0 });
    // a.txt に戻るのも「別のファイルを開く」なので先頭から
    expect(memory.positionFor('diff:s1', 'a.txt:false')).toEqual({ top: 0, left: 0 });
  });

  it('枠（タブ・ペインの種類）ごとに別々に覚える', () => {
    const memory = new ScrollMemory();
    memory.record('diff:s1', 'a.txt:false', { top: 100, left: 0 });
    memory.record('diff:s2', 'a.txt:false', { top: 900, left: 0 });

    expect(memory.positionFor('diff:s1', 'a.txt:false').top).toBe(100);
    expect(memory.positionFor('diff:s2', 'a.txt:false').top).toBe(900);
    expect(memory.positionFor('commit:s1', 'a.txt:false').top).toBe(0);
  });
});
