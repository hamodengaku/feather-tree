import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  GitCommandError,
  buildCloneCommand,
  cloneRepository,
  fetchUnshallow,
  getLfsVersion,
  lfsPull,
  setFetchAllBranches,
} from '../src/index.js';
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
    // 大規模クローンで「他のブランチも取れる」ことを見るため、既定以外のブランチを 1 本置く
    await fx.run('branch', 'feature');

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

  it('LFS の展開を止める指定は、このコマンドの環境変数にだけ載る', () => {
    const plain = buildCloneCommand(parentCtx(), { url: bare, directory: 'x', shallow: true });
    const skipping = buildCloneCommand(parentCtx(), { url: bare, directory: 'x', shallow: true, skipLfsSmudge: true });

    expect(plain.env).toBeUndefined();
    expect(skipping.env).toEqual({ GIT_LFS_SKIP_SMUDGE: '1' });
    expect(skipping.args.slice(-6)).toEqual(['--progress', '--depth', '1', '--', bare, 'x']);
  });

  /*
   * 大規模クローンの後半（対応表 #40 → #41）。
   * シャローで 1 ブランチ・1 コミットだけ取ったものが、全ブランチ・全履歴に戻ることを見る。
   */
  it('refspec を戻してから unshallow すると、全履歴と他のブランチがそろう', async () => {
    const target = sibling('large');
    await cloneRepository(parentCtx(), { url: pathToFileURL(bare).href, directory: target, shallow: true }, () => undefined);
    await expect(stat(join(target, '.git', 'shallow'))).resolves.toBeDefined();

    const repoCtx = { ...fx.ctx, cwd: target };
    await setFetchAllBranches(repoCtx);
    const lines: string[] = [];
    const exit = await fetchUnshallow(repoCtx, (l) => lines.push(l));

    expect(exit.code).toBe(0);
    expect((await fx.run('-C', target, 'rev-list', '--count', 'HEAD')).trim()).toBe('2');
    await expect(stat(join(target, '.git', 'shallow'))).rejects.toThrow();
    expect(await fx.run('-C', target, 'branch', '-r')).toContain('origin/feature');
  });

  it('完全なリポジトリに unshallow を打つと GitCommandError（呼び出し側が .git/shallow で飛ばす理由）', async () => {
    const target = sibling('full');
    await cloneRepository(parentCtx(), { url: bare, directory: target, shallow: false }, () => undefined);

    await expect(fetchUnshallow({ ...fx.ctx, cwd: target }, () => undefined)).rejects.toBeInstanceOf(GitCommandError);
  });

  /*
   * Git LFS（対応表 #38 / #39）。git-lfs が入っていない環境では、有無の判定だけを確かめる。
   */
  it('lfs version は git-lfs の有無を例外にせず返し、LFS を使わないリポジトリで lfs pull は成功する', async () => {
    const lfs = await getLfsVersion(parentCtx());
    if (lfs.version === null) {
      expect(lfs.exit.code).not.toBe(0);
      return;
    }
    expect(lfs.version).toMatch(/git-lfs/i);

    const target = sibling('lfs');
    await cloneRepository(parentCtx(), { url: bare, directory: target, shallow: false }, () => undefined);
    const exit = await lfsPull({ ...fx.ctx, cwd: target }, () => undefined);
    expect(exit.code).toBe(0);
  });
});
