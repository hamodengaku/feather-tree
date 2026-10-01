import { describe, expect, it } from 'vitest';
import { fileNameOf, fullPathOf } from '../src/lib/pathText.js';

const BS = String.fromCharCode(92);

describe('コピー用のパス文字列', () => {
  it('ファイル名は末尾の要素', () => {
    expect(fileNameOf('Assets/Prefabs/Player.prefab')).toBe('Player.prefab');
    expect(fileNameOf('README.md')).toBe('README.md');
    expect(fileNameOf('nested/')).toBe('nested');
  });

  it('Windows のルートなら区切りを \\ に揃える', () => {
    const root = ['C:', 'repo', 'game'].join(BS);
    expect(fullPathOf(root, 'Assets/a.cs')).toBe(['C:', 'repo', 'game', 'Assets', 'a.cs'].join(BS));
    expect(fullPathOf(root + BS, 'a.cs')).toBe(['C:', 'repo', 'game', 'a.cs'].join(BS));
    expect(fullPathOf('C:/repo', 'a/b.txt')).toBe(['C:', 'repo', 'a', 'b.txt'].join(BS));
  });

  it('POSIX のルートは / のまま', () => {
    expect(fullPathOf('/home/u/repo', 'a/b.txt')).toBe('/home/u/repo/a/b.txt');
  });
});
