import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitCommandError, cloneRepository } from '../src/index.js';
import { commitAll, createFixture, type Fixture } from './fixture.js';

/*
 * クローン（対応表 #37）。
 *
 * クローン元は .tmp/ 配下に作ったベアリポジトリ。ネットワークも認証も使わない。
 * 2 コミット積んでおき、浅いクローンで 1 件になることを確かめる。
 */
describe('クローン (対応表 #37)', () => {
  let fx: Fixture;
  let bare: string;
  /** fx.dir の外に作ったものは fixture の cleanup では消えないので、自分で覚えて消す。 */
  let extras: string[] = [];

  function sibling(prefix: string): string {
    const dir = join(fx.dir, '..', prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    extras.push(dir);
    return dir;
  }

  /** クローンは親フォルダを cwd にして走らせる（リポジトリがまだ無いため）。 */
  function parentCtx(): Fixture['ctx'] {
    return { ...fx.ctx, cwd: join(fx.dir, '..') };
  }

  beforeEach(async () => {
    fx = await createFixture();
    await fx.write('a.txt', 'x');
    await commitAll(fx, 'first');
    await fx.write('b.txt', 'y');
    await commitAll(fx, 'second');

    extras = [];
    bare = sibling('bare');
    await fx.run('clone', '--bare', fx.dir, bare);
  });

  afterEach(async () => {
    await fx.cleanup();
    for (const dir of extras) {
      // rmSync はこの環境でプロセスを即死させる（CLAUDE.md）。非同期版を使う。
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
  });

  it('クローンすると作業ツリーと履歴がそろい、進捗行を受け取る', async () => {
    const target = sibling('clone');
    const lines: string[] = [];

    await cloneRepository(parentCtx(), { url: bare, directory: target, shallow: false }, (l) => lines.push(l));

    const count = await fx.run('-C', target, 'rev-list', '--count', 'HEAD');
    expect(count.trim()).toBe('2');
    expect(lines.some((l) => /Cloning into/.test(l))).toBe(true);
  });

  it('浅いクローンは最新のコミットだけを取る（file:// のとき）', async () => {
    const target = sibling('shallow');

    await cloneRepository(
      parentCtx(),
      { url: pathToFileURL(bare).href, directory: target, shallow: true },
      () => undefined,
    );

    const count = await fx.run('-C', target, 'rev-list', '--count', 'HEAD');
    expect(count.trim()).toBe('1');
  });

  it('空でない既存フォルダへはクローンできず GitCommandError になる', async () => {
    const target = sibling('occupied');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'keep.txt'), 'x', 'utf8');

    await expect(
      cloneRepository(parentCtx(), { url: bare, directory: target, shallow: false }, () => undefined),
    ).rejects.toBeInstanceOf(GitCommandError);
  });

  it('- で始まる URL はオプションとして解釈されない（-- の後ろに置くため）', async () => {
    const target = sibling('dash');

    const error = await cloneRepository(
      parentCtx(),
      { url: '--upload-pack=nothing', directory: target, shallow: false },
      () => undefined,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitCommandError);
    // オプションとして食われていれば "unknown option" 系になる。リポジトリとして探しに行ったことを見る
    expect((error as GitCommandError).stderr).not.toMatch(/unknown option/i);
  });
});
