import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GitCommandError,
  fetchRemote,
  listBranches,
  pullCurrent,
  pushBranch,
} from '../src/index.js';
import { commitAll, createFixture, type Fixture } from './fixture.js';

/*
 * リモート操作（対応表 #22〜#25）。
 *
 * 本物のリモートが要るので、ベアリポジトリを .tmp/ 配下に作って push 先にする。
 * ネットワークも認証も使わないので、この検証は環境に依存しない。
 */
describe('リモート操作 (対応表 #22〜#25)', () => {
  let fx: Fixture;
  let bare: string;
  /** fx.dir の外に作ったものは fixture の cleanup では消えないので、自分で覚えて消す。 */
  let extras: string[] = [];

  function sibling(prefix: string): string {
    const dir = join(fx.dir, '..', prefix + '-' + Date.now().toString(36));
    extras.push(dir);
    return dir;
  }

  beforeEach(async () => {
    fx = await createFixture();
    await fx.write('a.txt', 'x');
    await commitAll(fx, 'init');

    extras = [];
    bare = sibling('bare');
    await mkdir(bare, { recursive: true });
    await fx.run('init', '--bare', '--initial-branch=main', bare);
    await fx.run('remote', 'add', 'origin', bare);
  });

  afterEach(async () => {
    await fx.cleanup();
    for (const dir of extras) {
      // rmSync はこの環境でプロセスを即死させる（CLAUDE.md）。非同期版を使う。
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
  });

  it('上流が無いブランチを --set-upstream つきでプッシュすると、追跡関係が張られる', async () => {
    await pushBranch(fx.ctx, 'origin', 'main', true);

    const branches = await listBranches(fx.ctx);
    const main = branches.find((b) => b.shortName === 'main');
    expect(main?.upstream).toBe('origin/main');
    expect(main?.ahead).toBe(0);
  });

  it('上流が張られたあとは --set-upstream なしでプッシュできる', async () => {
    await pushBranch(fx.ctx, 'origin', 'main', true);
    await fx.write('b.txt', 'y');
    await commitAll(fx, 'second');

    await pushBranch(fx.ctx, 'origin', 'main', false);

    const branches = await listBranches(fx.ctx);
    expect(branches.find((b) => b.shortName === 'main')?.ahead).toBe(0);
  });

  it('フェッチは作業ツリーを動かさず、リモート追跡ブランチだけを更新する', async () => {
    await pushBranch(fx.ctx, 'origin', 'main', true);

    // 別の作業コピーから 1 コミット進めて、こちらが behind の状態を作る
    const other = sibling('other');
    await fx.run('clone', bare, other);
    await fx.run('-C', other, 'config', 'user.name', 'T');
    await fx.run('-C', other, 'config', 'user.email', 't@example.invalid');
    await fx.run('-C', other, 'commit', '--allow-empty', '-m', 'from other');
    await fx.run('-C', other, 'push', 'origin', 'main');

    await fetchRemote(fx.ctx, 'origin');

    const branches = await listBranches(fx.ctx);
    expect(branches.find((b) => b.shortName === 'main')?.behind).toBe(1);
  });

  it('プルは上流の内容を作業ツリーへ取り込む', async () => {
    await pushBranch(fx.ctx, 'origin', 'main', true);

    const other = sibling('other');
    await fx.run('clone', bare, other);
    await fx.run('-C', other, 'config', 'user.name', 'T');
    await fx.run('-C', other, 'config', 'user.email', 't@example.invalid');
    await fx.run('-C', other, 'commit', '--allow-empty', '-m', 'from other');
    await fx.run('-C', other, 'push', 'origin', 'main');

    await pullCurrent(fx.ctx);

    const log = await fx.run('log', '--format=%s', '-1');
    expect(log.trim()).toBe('from other');
  });

  it('存在しないリモートへのフェッチは GitCommandError になる（ハングしない）', async () => {
    await expect(fetchRemote(fx.ctx, 'nowhere')).rejects.toBeInstanceOf(GitCommandError);
  });
});
