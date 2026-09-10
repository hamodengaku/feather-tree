import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppSettingsStore, DEFAULT_SETTINGS, normalizeSettings } from '../src/index.js';

// CLAUDE.md 規約 2: os.tmpdir() を使わずリポジトリ内の .tmp/ に閉じる
const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/core-tests');

const created: string[] = [];

async function tempDir(): Promise<string> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(join(TEST_ROOT, 'settings-'));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe('設定の正規化', () => {
  it('未知・不正な値は既定値で埋める（起動を止めない）', () => {
    const s = normalizeSettings({
      theme: 'rainbow',
      untrackedFiles: 'everything',
      diffContextLines: -5,
      logPageSize: 999999,
      recentRepositories: ['a', 42, null, 'b'],
      refocusUpdateMode: 'sometimes',
      unknownKey: 'ignored',
    });
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.untrackedFiles).toBe(DEFAULT_SETTINGS.untrackedFiles);
    expect(s.diffContextLines).toBe(0);
    expect(s.logPageSize).toBe(2000);
    expect(s.recentRepositories).toEqual(['a', 'b']);
    expect(s.refocusUpdateMode).toBe(DEFAULT_SETTINGS.refocusUpdateMode);
  });

  it('null / 非オブジェクトは既定値そのもの', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
  });

  it('有効な値は保持する', () => {
    const s = normalizeSettings({ theme: 'phoenix-dark', noRenames: true, untrackedFiles: 'all' });
    expect(s.theme).toBe('phoenix-dark');
    expect(s.noRenames).toBe(true);
    expect(s.untrackedFiles).toBe('all');
  });

  it('復帰時更新モードの有効な値は保持する', () => {
    expect(normalizeSettings({ refocusUpdateMode: 'modal' }).refocusUpdateMode).toBe('modal');
    expect(normalizeSettings({ refocusUpdateMode: 'none' }).refocusUpdateMode).toBe('none');
  });
});

describe('AppSettingsStore（土台の SettingsStore + FeatherTree のスキーマ）', () => {
  it('ファイルが無ければ既定値で始まる', async () => {
    const dir = await tempDir();
    const store = new AppSettingsStore(join(dir, 'settings.json'));
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  });

  it('壊れた JSON でも既定値で続行する', async () => {
    const dir = await tempDir();
    const file = join(dir, 'settings.json');
    await writeFile(file, '{ this is not json', 'utf8');
    const store = new AppSettingsStore(file);
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  });

  it('更新を保存して読み直せる', async () => {
    const dir = await tempDir();
    const file = join(dir, 'nested', 'settings.json');
    const store = new AppSettingsStore(file);
    await store.load();
    await store.update({ theme: 'classic-light', noRenames: true });

    const reloaded = new AppSettingsStore(file);
    const s = await reloaded.load();
    expect(s.theme).toBe('classic-light');
    expect(s.noRenames).toBe(true);

    // 一時ファイル経由で差し替えるので中間ファイルは残らない
    await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toThrow();
  });

  it('最近開いたリポジトリを先頭へ移す', async () => {
    const dir = await tempDir();
    const store = new AppSettingsStore(join(dir, 'settings.json'));
    await store.load();
    await store.touchRepository('C:/a');
    await store.touchRepository('C:/b');
    await store.touchRepository('C:/a');
    expect(store.current.recentRepositories).toEqual(['C:/a', 'C:/b']);
  });
});
