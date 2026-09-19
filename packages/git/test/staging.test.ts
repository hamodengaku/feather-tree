import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commit,
  discardStagedAndWorktree,
  discardWorktree,
  getLog,
  getStatus,
  removeUntracked,
  stagePaths,
  unstagePaths,
} from '../src/index.js';
import { commitAll, createFixture, type Fixture } from './fixture.js';

const LF = String.fromCharCode(10);

describe('ステージングとコミット (対応表 #5〜#11)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('ファイル単位でステージできる', async () => {
    await fx.write('a.txt', 'x');
    await fx.write('b.txt', 'y');

    await stagePaths(fx.ctx, ['a.txt']);

    const s = await getStatus(fx.ctx);
    expect(s.entries.find((e) => e.path === 'a.txt')?.staged).toBe('A');
    expect(s.entries.find((e) => e.path === 'b.txt')?.kind).toBe('untracked');
  });

  it('日本語・空白・記号を含むパスをステージできる', async () => {
    const tricky = '日本語 と 記号 (1) &.txt';
    await fx.write(tricky, 'x');

    await stagePaths(fx.ctx, [tricky]);

    const s = await getStatus(fx.ctx);
    expect(s.entries.find((e) => e.path === tricky)?.staged).toBe('A');
  });

  it('大量のパスでもコマンドライン長制限に当たらない（--pathspec-from-file）', async () => {
    const paths: string[] = [];
    for (let i = 0; i < 1500; i += 1) {
      const p = `deep/directory/structure/that/makes/paths/long/file_${String(i).padStart(5, '0')}.txt`;
      await fx.write(p, 'x');
      paths.push(p);
    }

    await stagePaths(fx.ctx, paths);

    const s = await getStatus(fx.ctx);
    expect(s.counts.staged).toBe(1500);
  });

  it('ステージから戻せる', async () => {
    await fx.write('a.txt', 'one');
    await commitAll(fx, 'init');
    await fx.write('a.txt', 'two');
    await stagePaths(fx.ctx, ['a.txt']);

    await unstagePaths(fx.ctx, ['a.txt']);

    const s = await getStatus(fx.ctx);
    const entry = s.entries.find((e) => e.path === 'a.txt');
    expect(entry?.staged).toBe('.');
    expect(entry?.worktree).toBe('M');
  });

  it('作業ツリーの変更だけを破棄する', async () => {
    await fx.write('a.txt', 'one');
    await commitAll(fx, 'init');
    await fx.write('a.txt', 'two');

    await discardWorktree(fx.ctx, ['a.txt']);

    expect(await readFile(join(fx.dir, 'a.txt'), 'utf8')).toBe('one');
    expect((await getStatus(fx.ctx)).entries).toHaveLength(0);
  });

  it('ステージ済みも含めて破棄する', async () => {
    await fx.write('a.txt', 'one');
    await commitAll(fx, 'init');
    await fx.write('a.txt', 'staged');
    await stagePaths(fx.ctx, ['a.txt']);
    await fx.write('a.txt', 'worktree');

    await discardStagedAndWorktree(fx.ctx, ['a.txt']);

    expect(await readFile(join(fx.dir, 'a.txt'), 'utf8')).toBe('one');
    expect((await getStatus(fx.ctx)).entries).toHaveLength(0);
  });

  it('未追跡ファイルを削除する', async () => {
    await fx.write('trash.txt', 'x');
    await fx.write('keep.txt', 'y');
    await stagePaths(fx.ctx, ['keep.txt']);

    await removeUntracked(fx.ctx, ['trash.txt']);

    await expect(stat(join(fx.dir, 'trash.txt'))).rejects.toThrow();
    await expect(stat(join(fx.dir, 'keep.txt'))).resolves.toBeTruthy();
  });

  it('未追跡ディレクトリも削除できる（-d）', async () => {
    await fx.write('trashdir/a.txt', 'x');
    await removeUntracked(fx.ctx, ['trashdir/']);
    await expect(stat(join(fx.dir, 'trashdir'))).rejects.toThrow();
  });

  it('大量の未追跡ファイルを分割実行で削除できる', async () => {
    const paths: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      const p = `junk/file_${String(i)}.txt`;
      await fx.write(p, 'x');
      paths.push(p);
    }

    await removeUntracked(fx.ctx, paths);

    expect((await getStatus(fx.ctx)).counts.untracked).toBe(0);
  });

  /*
   * 破壊的バグ診断（.tmp/release-prep/destructive.md #1）: `git clean` はパス無しで打つと
   * リポジトリ全体の未追跡ファイルを無条件に全削除する安全弁の無いコマンド。CLEAN_CHUNK
   * ちょうどの件数・その前後で「最後のチャンクが空になる」ような off-by-one が
   * 将来のリファクタリングで入り込んでいないかを境界値で確かめる（199 / 200 / 201 件）。
   */
  it.each([199, 200, 201])('CLEAN_CHUNK の境界（%i 件）でも欠けなく削除される', async (count) => {
    const paths: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const p = `boundary/file_${String(i)}.txt`;
      await fx.write(p, 'x');
      paths.push(p);
    }

    await removeUntracked(fx.ctx, paths);

    expect((await getStatus(fx.ctx)).counts.untracked).toBe(0);
  });

  it('空配列では git を実行せず、リポジトリ全体を削除するような事故も起きない', async () => {
    await fx.write('keep1.txt', 'x');
    await fx.write('keep2.txt', 'y');

    await removeUntracked(fx.ctx, []);

    await expect(stat(join(fx.dir, 'keep1.txt'))).resolves.toBeTruthy();
    await expect(stat(join(fx.dir, 'keep2.txt'))).resolves.toBeTruthy();
  });

  it('複数行・日本語のコミットメッセージを扱える', async () => {
    await fx.write('a.txt', 'x');
    await stagePaths(fx.ctx, ['a.txt']);

    const message = ['機能: 日本語の件名', '', '本文の 1 行目', '本文の 2 行目 "引用" と & 記号'].join(LF);
    const oid = await commit(fx.ctx, message);

    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    const log = await getLog(fx.ctx);
    expect(log[0]?.subject).toBe('機能: 日本語の件名');
    const body = await fx.run('log', '-1', '--format=%B');
    expect(body).toContain('本文の 2 行目 "引用" と & 記号');
  });

  it('--amend で直前のコミットを修正する', async () => {
    await fx.write('a.txt', 'x');
    await stagePaths(fx.ctx, ['a.txt']);
    await commit(fx.ctx, '最初');

    await fx.write('b.txt', 'y');
    await stagePaths(fx.ctx, ['b.txt']);
    await commit(fx.ctx, '修正後', { amend: true });

    const log = await getLog(fx.ctx);
    expect(log).toHaveLength(1);
    expect(log[0]?.subject).toBe('修正後');
  });

  it('空のパス配列では git を実行しない', async () => {
    await fx.write('a.txt', 'x');
    await stagePaths(fx.ctx, []);
    expect((await getStatus(fx.ctx)).counts.staged).toBe(0);
  });

  it('一時ファイルは実行後に必ず削除される', async () => {
    await fx.write('a.txt', 'x');
    await stagePaths(fx.ctx, ['a.txt']);

    const { readdir } = await import('node:fs/promises');
    const left = await readdir(fx.ctx.tempDir).catch(() => [] as string[]);
    expect(left).toEqual([]);
  });
});
