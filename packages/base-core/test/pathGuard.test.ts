import { randomBytes } from 'node:crypto';
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathOutsideRootError, assertInsideRoot, assertRealPathInsideRoot } from '../src/index.js';

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

/*
 * assertRealPathInsideRoot（診断 Medium 1: ジャンクション／シンボリックリンク経由の
 * リポジトリ外参照）。assertInsideRoot は文字列操作だけなので、ワークツリー内のジャンクション
 * （Windows では無権限で作成できる）がリポジトリ外を指していても文字列上は素通りしてしまう。
 * 実際にジャンクションを作って実体解決を検証する（CLAUDE.md 規約により .tmp/ 配下、rmSync は使わない）。
 */
describe('assertRealPathInsideRoot（ジャンクション経由のリポジトリ外参照, Medium 1）', () => {
  const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/pathguard-tests');
  let testDir: string;

  beforeEach(async () => {
    testDir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });

  it('通常のファイルは実体パス（大小文字を含めて比較用に揃えたもの）を返す', async () => {
    const root = join(testDir, 'repo');
    await mkdir(root, { recursive: true });
    const file = join(root, 'a.txt');
    await writeFile(file, 'x', 'utf8');

    const real = await assertRealPathInsideRoot(root, file);
    expect(real.toLowerCase()).toBe((await realpath(file)).toLowerCase());
  });

  it('ジャンクション配下のパスが実体としてリポジトリ外を指す場合は拒否する', async () => {
    const root = join(testDir, 'repo');
    const outside = join(testDir, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'leak', 'utf8');

    // ワークツリー内にジャンクションを作る。文字列上は root 配下（root/link/...）に見える。
    const junctionPath = join(root, 'link');
    await symlink(outside, junctionPath, 'junction');

    const target = join(root, 'link', 'secret.txt');
    await expect(assertRealPathInsideRoot(root, target)).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it('ジャンクションがリポジトリ配下の別の場所を指すだけなら通す（偽陽性を出さない）', async () => {
    const root = join(testDir, 'repo');
    const realAssets = join(root, 'real-assets');
    await mkdir(realAssets, { recursive: true });
    await writeFile(join(realAssets, 'inside.txt'), 'ok', 'utf8');

    const junctionPath = join(root, 'link');
    await symlink(realAssets, junctionPath, 'junction');

    const target = join(root, 'link', 'inside.txt');
    const result = await assertRealPathInsideRoot(root, target);
    expect(result.toLowerCase()).toBe((await realpath(target)).toLowerCase());
  });

  it('存在しないファイルは realpath できないので、渡された絶対パスをそのまま返す（既存の「ファイルが無い」失敗経路に委ねる）', async () => {
    const root = join(testDir, 'repo2');
    await mkdir(root, { recursive: true });
    const missing = join(root, 'missing.txt');

    const real = await assertRealPathInsideRoot(root, missing);
    expect(real).toBe(missing);
  });
});
