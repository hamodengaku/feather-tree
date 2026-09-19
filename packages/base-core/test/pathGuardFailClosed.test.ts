import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FsPromises from 'node:fs/promises';

/*
 * 診断 Medium 1（残存指摘）: `assertRealPathInsideRoot` は対象の `realpath` が失敗したとき、
 * ENOENT（ファイルが無い）以外の理由でも無条件に元のパスを素通りさせていた（fail-open）。
 * EACCES・ELOOP 等、実際にそのエラーコードを起こすのが難しい（要管理者権限・OS 依存）ケースを、
 * `node:fs/promises` の `realpath` をこのファイル内だけ差し替えて検証する。
 *
 * `vi.importActual` で取り出した本物の実装をテスト側のファイル操作と「差し替えていない
 * パスの委譲先」に使い、モック側（SUT が実際に呼ぶもの）とは完全に分離する
 * （同じ束縛を両方に使うと mockImplementation が自分自身を呼ぶ無限再帰になる）。
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

const actualFsPromises = await vi.importActual<typeof FsPromises>('node:fs/promises');
const { realpath: mockedRealpathExport } = await import('node:fs/promises');
const mockedRealpath = mockedRealpathExport as unknown as ReturnType<typeof vi.fn>;

const { assertRealPathInsideRoot, PathOutsideRootError } = await import('../src/fs/pathGuard.js');

const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/pathguard-failclosed-tests');

describe('assertRealPathInsideRoot（realpath が ENOENT 以外で失敗した場合は fail closed, 診断 Medium 1）', () => {
  let testDir: string;
  let root: string;
  let target: string;

  beforeEach(async () => {
    testDir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    root = join(testDir, 'repo');
    await actualFsPromises.mkdir(root, { recursive: true });
    target = join(root, 'a.txt');
    await actualFsPromises.writeFile(target, 'x', 'utf8');
    mockedRealpath.mockClear();
    mockedRealpath.mockImplementation(actualFsPromises.realpath);
  });

  afterEach(async () => {
    mockedRealpath.mockReset();
    await actualFsPromises
      .rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      .catch(() => undefined);
  });

  it('EACCES（権限拒否）は拒否する（素通りさせない）', async () => {
    mockedRealpath.mockImplementation(async (p: Parameters<typeof actualFsPromises.realpath>[0]) => {
      if (p === target) {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return actualFsPromises.realpath(p);
    });

    await expect(assertRealPathInsideRoot(root, target)).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it('ELOOP（シンボリックリンクの循環）は拒否する（素通りさせない）', async () => {
    mockedRealpath.mockImplementation(async (p: Parameters<typeof actualFsPromises.realpath>[0]) => {
      if (p === target) {
        const err = new Error('too many symbolic links encountered') as NodeJS.ErrnoException;
        err.code = 'ELOOP';
        throw err;
      }
      return actualFsPromises.realpath(p);
    });

    await expect(assertRealPathInsideRoot(root, target)).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it('ENOENT（ファイルが無い）は従来どおり素通りする', async () => {
    const missing = join(root, 'missing.txt');
    mockedRealpath.mockImplementation(async (p: Parameters<typeof actualFsPromises.realpath>[0]) => {
      if (p === missing) {
        const err = new Error('no such file or directory') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return actualFsPromises.realpath(p);
    });

    const real = await assertRealPathInsideRoot(root, missing);
    expect(real).toBe(missing);
  });

  it('ENOTDIR も従来どおり素通りする', async () => {
    const underFile = join(target, 'nested.txt');
    mockedRealpath.mockImplementation(async (p: Parameters<typeof actualFsPromises.realpath>[0]) => {
      if (p === underFile) {
        const err = new Error('not a directory') as NodeJS.ErrnoException;
        err.code = 'ENOTDIR';
        throw err;
      }
      return actualFsPromises.realpath(p);
    });

    const real = await assertRealPathInsideRoot(root, underFile);
    expect(real).toBe(underFile);
  });
});
