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

  it('branchLocalHeight は範囲外を既定値に丸め、有効な値は保持する', () => {
    expect(normalizeSettings({ branchLocalHeight: 5 }).branchLocalHeight).toBe(80);
    expect(normalizeSettings({ branchLocalHeight: 99999 }).branchLocalHeight).toBe(4000);
    expect(normalizeSettings({ branchLocalHeight: 300 }).branchLocalHeight).toBe(300);
  });

  it('branchPaneCollapsed は真偽値以外なら既定値（false）にする', () => {
    expect(normalizeSettings({}).branchPaneCollapsed).toBe(false);
    expect(normalizeSettings({ branchPaneCollapsed: 'yes' }).branchPaneCollapsed).toBe(false);
    expect(normalizeSettings({ branchPaneCollapsed: true }).branchPaneCollapsed).toBe(true);
  });

  it('branchExpanded は壊れた値を捨て、リポジトリごとの配列だけを残す', () => {
    expect(normalizeSettings({}).branchExpanded).toEqual({});
    expect(normalizeSettings({ branchExpanded: 'nope' }).branchExpanded).toEqual({});
    expect(
      normalizeSettings({
        branchExpanded: {
          'C:/repo': ['local:feature', 42, null, 'remote:origin'],
          'C:/empty': [],
          'C:/bad': 'not-an-array',
        },
      }).branchExpanded,
    ).toEqual({ 'C:/repo': ['local:feature', 'remote:origin'] });
  });

  it('branchExpanded はリポジトリ 30 件までで、先頭から残す', () => {
    const raw: Record<string, string[]> = {};
    for (let i = 0; i < 40; i += 1) raw['repo' + i] = ['local:feature'];
    const kept = Object.keys(normalizeSettings({ branchExpanded: raw }).branchExpanded);
    expect(kept).toHaveLength(30);
    expect(kept[0]).toBe('repo0');
  });
  it('commandLogHeight は範囲外を既定値に丸め、有効な値は保持する', () => {
    expect(normalizeSettings({ commandLogHeight: 1 }).commandLogHeight).toBe(120);
    expect(normalizeSettings({ commandLogHeight: 99999 }).commandLogHeight).toBe(800);
    expect(normalizeSettings({ commandLogHeight: 300 }).commandLogHeight).toBe(300);
  });

  it('stagedHeight は範囲外を既定値に丸め、有効な値は保持する', () => {
    expect(normalizeSettings({ stagedHeight: 5 }).stagedHeight).toBe(80);
    expect(normalizeSettings({ stagedHeight: 99999 }).stagedHeight).toBe(4000);
    expect(normalizeSettings({ stagedHeight: 300 }).stagedHeight).toBe(300);
  });

  /* コミットログモード（決定 27）の 4 キー。 */

  it('viewMode は既定が差分モードで、知らない値なら既定へ落ちる', () => {
    expect(normalizeSettings({}).viewMode).toBe('diff');
    expect(normalizeSettings({ viewMode: 'log' }).viewMode).toBe('log');
    expect(normalizeSettings({ viewMode: 'graph' }).viewMode).toBe('diff');
    expect(normalizeSettings({ viewMode: 3 }).viewMode).toBe('diff');
  });

  it('logDetailHeight は範囲外を既定値に丸め、有効な値は保持する', () => {
    expect(normalizeSettings({}).logDetailHeight).toBe(260);
    expect(normalizeSettings({ logDetailHeight: 1 }).logDetailHeight).toBe(120);
    expect(normalizeSettings({ logDetailHeight: 99999 }).logDetailHeight).toBe(2000);
    expect(normalizeSettings({ logDetailHeight: 400 }).logDetailHeight).toBe(400);
  });

  /*
   * 畳めるペインはブランチペインだけ（決定 27）。コミットログモードでも
   * 縦帯の折り畳みボタンはそれを相手にするので、折り畳み状態のキーは 1 つしかない。
   * logDetailCollapsed のような二重のキーを足さないことを、ここで固定しておく。
   */
  it('折り畳みの状態は branchPaneCollapsed の 1 つだけ', () => {
    const keys = Object.keys(normalizeSettings({})).filter((k) => k.toLowerCase().includes('collapsed'));
    expect(keys).toEqual(['branchPaneCollapsed']);
  });

  it('commitFileListWidth は範囲外を既定値に丸め、有効な値は保持する', () => {
    expect(normalizeSettings({}).commitFileListWidth).toBe(260);
    expect(normalizeSettings({ commitFileListWidth: 1 }).commitFileListWidth).toBe(120);
    expect(normalizeSettings({ commitFileListWidth: 99999 }).commitFileListWidth).toBe(1200);
    expect(normalizeSettings({ commitFileListWidth: 300 }).commitFileListWidth).toBe(300);
  });

  it('tabShowCurrentInfo は既定でオンで、真偽値以外なら既定に落ちる', () => {
    expect(normalizeSettings({}).tabShowCurrentInfo).toBe(true);
    expect(normalizeSettings({ tabShowCurrentInfo: false }).tabShowCurrentInfo).toBe(false);
    expect(normalizeSettings({ tabShowCurrentInfo: 'yes' }).tabShowCurrentInfo).toBe(true);
  });

  it('paneWidths.centerRatio は未指定/不正なら null、範囲外はクランプする', () => {
    expect(normalizeSettings({}).paneWidths.centerRatio).toBeNull();
    expect(normalizeSettings({ paneWidths: { centerRatio: 'nope' } }).paneWidths.centerRatio).toBeNull();
    expect(normalizeSettings({ paneWidths: { centerRatio: 0.01 } }).paneWidths.centerRatio).toBe(0.1);
    expect(normalizeSettings({ paneWidths: { centerRatio: 0.99 } }).paneWidths.centerRatio).toBe(0.9);
    expect(normalizeSettings({ paneWidths: { centerRatio: 0.6 } }).paneWidths.centerRatio).toBe(0.6);
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
