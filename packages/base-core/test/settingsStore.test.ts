import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsStore, boolOr, clampInt, pickFrom, record, stringArray, stringOrNull } from '../src/index.js';

// os.tmpdir() は使わずリポジトリ内に閉じる
const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/base-core-tests');
const created: string[] = [];

async function tempDir(): Promise<string> {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(join(TEST_ROOT, 'store-'));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
});

interface Sample {
  readonly name: string;
  readonly count: number;
}

const DEFAULTS: Sample = { name: 'default', count: 1 };

const normalize = (raw: unknown): Sample => {
  const o = record(raw);
  return {
    name: stringOrNull(o['name']) ?? DEFAULTS.name,
    count: clampInt(o['count'], 0, 10, DEFAULTS.count),
  };
};

describe('SettingsStore（土台）', () => {
  it('ファイルが無ければ正規化された既定値で始まる', async () => {
    const store = new SettingsStore(join(await tempDir(), 's.json'), normalize);
    expect(await store.load()).toEqual(DEFAULTS);
    expect(store.current).toEqual(DEFAULTS);
  });

  it('壊れた JSON でも既定値で続行する（起動を止めない）', async () => {
    const dir = await tempDir();
    const file = join(dir, 's.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{ not json', 'utf8');
    const store = new SettingsStore(file, normalize);
    expect(await store.load()).toEqual(DEFAULTS);
  });

  it('更新を保存して読み直せる。親ディレクトリも作る', async () => {
    const file = join(await tempDir(), 'nested', 'deeper', 's.json');
    const store = new SettingsStore(file, normalize);
    await store.load();
    await store.update({ name: 'changed', count: 5 });

    const reloaded = new SettingsStore(file, normalize);
    expect(await reloaded.load()).toEqual({ name: 'changed', count: 5 });
  });

  it('保存は一時ファイル経由なので中間ファイルが残らない', async () => {
    const file = join(await tempDir(), 's.json');
    const store = new SettingsStore(file, normalize);
    await store.update({ count: 3 });
    await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toThrow();
  });

  it('更新時も正規化が効く（範囲外の値を丸める）', async () => {
    const store = new SettingsStore(join(await tempDir(), 's.json'), normalize);
    await store.update({ count: 999 } as Partial<Sample>);
    expect(store.current.count).toBe(10);
  });

  it('load を呼ばずに update しても動く', async () => {
    const store = new SettingsStore(join(await tempDir(), 's.json'), normalize);
    expect((await store.update({ name: 'x' })).name).toBe('x');
  });
});

describe('正規化ヘルパ（土台）', () => {
  it('clampInt は範囲外・非数値を丸める', () => {
    expect(clampInt(5, 0, 10, 1)).toBe(5);
    expect(clampInt(-5, 0, 10, 1)).toBe(0);
    expect(clampInt(50, 0, 10, 1)).toBe(10);
    expect(clampInt('nope', 0, 10, 1)).toBe(1);
    expect(clampInt(Number.NaN, 0, 10, 1)).toBe(1);
    expect(clampInt(3.7, 0, 10, 1)).toBe(4);
  });

  it('stringArray は文字列だけを取り出して上限で切る', () => {
    expect(stringArray(['a', 1, null, 'b', ''], 10)).toEqual(['a', 'b']);
    expect(stringArray(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
    expect(stringArray('not array', 10)).toEqual([]);
  });

  it('pickFrom は許可された値だけを通す', () => {
    expect(pickFrom('dark', ['dark', 'light'], 'light')).toBe('dark');
    expect(pickFrom('rainbow', ['dark', 'light'], 'light')).toBe('light');
    expect(pickFrom(42, ['dark', 'light'], 'light')).toBe('light');
  });

  it('boolOr / stringOrNull / record', () => {
    expect(boolOr(true, false)).toBe(true);
    expect(boolOr('yes', false)).toBe(false);
    expect(stringOrNull('x')).toBe('x');
    expect(stringOrNull('')).toBeNull();
    expect(stringOrNull(5)).toBeNull();
    expect(record({ a: 1 })).toEqual({ a: 1 });
    expect(record(null)).toEqual({});
    expect(record('x')).toEqual({});
  });
});
