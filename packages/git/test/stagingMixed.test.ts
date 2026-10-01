import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getStatus, stagePaths } from '../src/index.js';
import { commitAll, createFixture, type Fixture } from './fixture.js';

/**
 * 多様なステータスが混在した選択の一括ステージ（#5）。
 * 2026-09-30 の利用者報告（全件選択してステージするとエラー）の回帰テスト。
 */
describe('混在ステータスの一括ステージ（#5）', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('変更・削除・未追跡・リネーム・競合が混在しても 1 回でステージできる', async () => {
    await fx.write('mod.txt', 'a\n');
    await fx.write('del.txt', 'b\n');
    await fx.write('ren.txt', 'c\n');
    await fx.write('conf.txt', 'base\n');
    await commitAll(fx, 'init');
    await fx.run('switch', '-c', 'other');
    await fx.write('conf.txt', 'other\n');
    await commitAll(fx, 'other');
    await fx.run('switch', 'main');
    await fx.write('conf.txt', 'main\n');
    await commitAll(fx, 'main');
    await fx.run('merge', 'other').catch(() => undefined);

    await fx.write('mod.txt', 'a\nmod\n');
    await rm(join(fx.dir, 'del.txt'));
    await fx.run('mv', 'ren.txt', 'ren2.txt');
    await fx.write('ren2.txt', 'c\nzz\n');
    await fx.write('untracked.txt', 'n\n');

    const before = await getStatus(fx.ctx);
    const paths = before.entries
      .filter((e) => e.kind === 'untracked' || e.kind === 'unmerged' || e.worktree !== '.')
      .map((e) => e.path);

    await stagePaths(fx.ctx, paths);

    const after = await getStatus(fx.ctx);
    expect(after.entries.filter((e) => e.kind !== 'ordinary' && e.kind !== 'renamed')).toEqual([]);
    expect(after.entries.every((e) => e.worktree === '.')).toBe(true);
  });

  it('ignore にかかる追跡済みファイルは素の add では失敗し、add -u なら入る', async () => {
    await fx.write('ign/a.txt', '1\n');
    await fx.write('ign/b.txt', '1\n');
    await commitAll(fx, 'init');
    await fx.write('.gitignore', 'ign/\n');
    await fx.write('ign/a.txt', '2\n');
    await rm(join(fx.dir, 'ign/b.txt'));

    // 素の add は「paths are ignored」で全体を失敗させる（git 自身の挙動の確認）
    await expect(stagePaths(fx.ctx, ['ign/a.txt'])).rejects.toThrow();

    await stagePaths(fx.ctx, ['ign/a.txt', 'ign/b.txt'], { trackedOnly: true });

    const s = await getStatus(fx.ctx);
    expect(s.entries.find((e) => e.path === 'ign/a.txt')?.staged).toBe('M');
    expect(s.entries.find((e) => e.path === 'ign/b.txt')?.staged).toBe('D');
  });
});
