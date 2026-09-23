import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getStatus } from '../src/index.js';
import { commitAll, createFixture, type Fixture } from './fixture.js';

describe('getStatus (対応表 #2)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('コミットが 1 つも無いリポジトリを扱える', async () => {
    const s = await getStatus(fx.ctx);
    expect(s.head.oid).toBeNull();
    expect(s.head.branch).toBe('main');
    expect(s.head.detached).toBe(false);
    expect(s.entries).toHaveLength(0);
  });

  it('未追跡ファイルを検出する', async () => {
    await fx.write('a.txt', 'hello\n');
    const s = await getStatus(fx.ctx);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]?.kind).toBe('untracked');
    expect(s.entries[0]?.path).toBe('a.txt');
    expect(s.counts.untracked).toBe(1);
  });

  it('日本語ファイル名を 8 進エスケープせずに返す（core.quotepath=false）', async () => {
    await fx.write('日本語のファイル.txt', 'あいうえお\n');
    const s = await getStatus(fx.ctx);
    expect(s.entries.map((e) => e.path)).toContain('日本語のファイル.txt');
  });

  it('未追跡ディレクトリは normal では 1 エントリに畳まれる（git の仕様）', async () => {
    await fx.write('dir with space/a b (1).txt', 'x');
    await fx.write('絵文字😀/ファイル.txt', 'y');
    const s = await getStatus(fx.ctx, { untrackedFiles: 'normal' });
    const paths = s.entries.map((e) => e.path).sort();
    // --untracked-files=normal はディレクトリ単位で報告する。
    // アプリは使わない（既定は all）。畳まれた `dir/` を選ぶと EISDIR になっていた
    expect(paths).toEqual(['dir with space/', '絵文字😀/']);
  });

  it('既定（all）では空白・記号・絵文字を含むパスを 1 件ずつ返す', async () => {
    await fx.write('dir with space/a b (1).txt', 'x');
    await fx.write('絵文字😀/ファイル.txt', 'y');
    const s = await getStatus(fx.ctx);
    const paths = s.entries.map((e) => e.path);
    expect(paths).toContain('dir with space/a b (1).txt');
    expect(paths).toContain('絵文字😀/ファイル.txt');
  });

  it('ステージ済みと未ステージを区別する', async () => {
    await fx.write('a.txt', 'one\n');
    await commitAll(fx, 'init');

    await fx.write('a.txt', 'two\n');
    await fx.run('add', 'a.txt');
    await fx.write('a.txt', 'three\n');

    const s = await getStatus(fx.ctx);
    const entry = s.entries.find((e) => e.path === 'a.txt');
    expect(entry?.kind).toBe('ordinary');
    expect(entry?.staged).toBe('M');
    expect(entry?.worktree).toBe('M');
    expect(s.counts.staged).toBe(1);
    expect(s.counts.unstaged).toBe(1);
  });

  it('リネームを新パスと元パスの両方で返す（種別 2 の 2 レコード問題）', async () => {
    await fx.write('もとの名前.txt', 'a'.repeat(200));
    await commitAll(fx, 'init');
    await fx.run('mv', 'もとの名前.txt', 'あたらしい名前.txt');

    const s = await getStatus(fx.ctx);
    const renamed = s.entries.find((e) => e.kind === 'renamed');
    expect(renamed).toBeDefined();
    expect(renamed?.path).toBe('あたらしい名前.txt');
    expect(renamed?.origPath).toBe('もとの名前.txt');
    expect(renamed?.staged).toBe('R');
    expect(renamed?.score).toBeGreaterThan(0);
  });

  it('リネームと通常変更が混在しても後続エントリがずれない', async () => {
    await fx.write('r.txt', 'b'.repeat(200));
    await fx.write('m.txt', 'keep\n');
    await fx.write('z.txt', 'keep\n');
    await commitAll(fx, 'init');

    await fx.run('mv', 'r.txt', 'r2.txt');
    await fx.write('m.txt', 'changed\n');

    const s = await getStatus(fx.ctx);
    const paths = s.entries.map((e) => e.path).sort();
    expect(paths).toEqual(['m.txt', 'r2.txt']);
    expect(s.entries.find((e) => e.path === 'm.txt')?.kind).toBe('ordinary');
    expect(s.entries.find((e) => e.path === 'r2.txt')?.origPath).toBe('r.txt');
  });

  it('削除を検出する', async () => {
    await fx.write('a.txt', 'x\n');
    await commitAll(fx, 'init');
    await fx.run('rm', 'a.txt');

    const s = await getStatus(fx.ctx);
    expect(s.entries[0]?.staged).toBe('D');
  });

  it('detached HEAD を検出する', async () => {
    await fx.write('a.txt', 'x\n');
    await commitAll(fx, 'init');
    const oid = (await fx.run('rev-parse', 'HEAD')).trim();
    await fx.run('checkout', '--detach', oid);

    const s = await getStatus(fx.ctx);
    expect(s.head.detached).toBe(true);
    expect(s.head.branch).toBeNull();
    expect(s.head.oid).toBe(oid);
  });

  it('--no-renames でリネームを通常の削除＋追加として扱える', async () => {
    await fx.write('r.txt', 'c'.repeat(200));
    await commitAll(fx, 'init');
    await fx.run('mv', 'r.txt', 'r2.txt');

    const s = await getStatus(fx.ctx, { noRenames: true });
    expect(s.entries.some((e) => e.kind === 'renamed')).toBe(false);
    expect(s.entries).toHaveLength(2);
  });

  it('コンフリクト（未マージ）を検出する', async () => {
    await fx.write('c.txt', 'base\n');
    await commitAll(fx, 'base');
    await fx.run('checkout', '-b', 'other');
    await fx.write('c.txt', 'other\n');
    await commitAll(fx, 'other');
    await fx.run('checkout', 'main');
    await fx.write('c.txt', 'main\n');
    await commitAll(fx, 'main');
    await fx.run('merge', 'other').catch(() => undefined);

    const s = await getStatus(fx.ctx);
    expect(s.counts.unmerged).toBe(1);
    expect(s.entries[0]?.kind).toBe('unmerged');
  });
});
