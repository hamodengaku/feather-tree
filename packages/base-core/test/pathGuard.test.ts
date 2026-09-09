import { describe, expect, it } from 'vitest';
import { PathOutsideRootError, assertInsideRoot } from '../src/index.js';

const ROOT = 'D:/work/root';
const BS = String.fromCharCode(92);

describe('パス・トラバーサルの防止（土台）', () => {
  it('リポジトリ配下の相対パスは通る', () => {
    for (const p of ['a.txt', 'src/a.txt', 'Assets/Group01/asset.png', '日本語 ファイル.txt', 'dir/']) {
      expect(() => assertInsideRoot(ROOT, p)).not.toThrow();
    }
  });

  it('親ディレクトリへ抜けるパスを拒否する', () => {
    for (const p of ['../secret.txt', '../../etc/passwd', 'src/../../outside.txt', '..']) {
      expect(() => assertInsideRoot(ROOT, p)).toThrow(PathOutsideRootError);
    }
  });

  it('絶対パスを拒否する', () => {
    for (const p of ['C:/Windows/system32/cmd.exe', `C:${BS}Windows`, '/etc/passwd']) {
      expect(() => assertInsideRoot(ROOT, p)).toThrow(PathOutsideRootError);
    }
  });

  it('空文字を拒否する', () => {
    expect(() => assertInsideRoot(ROOT, '')).toThrow(PathOutsideRootError);
  });

  it('バックスラッシュ区切りの脱出も拒否する', () => {
    expect(() => assertInsideRoot(ROOT, `..${BS}outside.txt`)).toThrow(PathOutsideRootError);
    expect(() => assertInsideRoot(ROOT, `src${BS}..${BS}..${BS}outside.txt`)).toThrow(
      PathOutsideRootError,
    );
  });

  it('正規化後に配下へ収まるものは通る', () => {
    expect(() => assertInsideRoot(ROOT, 'src/./a.txt')).not.toThrow();
    expect(() => assertInsideRoot(ROOT, 'src/sub/../a.txt')).not.toThrow();
  });
});
