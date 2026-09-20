import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBranch,
  GitCommandError,
  listBranches,
  listRemotes,
  mergeBranch,
  resolveRepository,
  switchBranch,
  switchToRemoteBranch,
} from '../src/index.js';
import { commitAll, createFixture, type Fixture } from './fixture.js';

describe('リポジトリとブランチ (対応表 #1 / #3 / #4)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
    await fx.write('a.txt', 'x');
    await commitAll(fx, 'init');
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('ルートと .git ディレクトリを 1 回の実行で取得する', async () => {
    const loc = await resolveRepository(fx.ctx);
    // Windows の区切り文字差を吸収して比較する
    const norm = (p: string): string => p.split(String.fromCharCode(92)).join(String.fromCharCode(47)).toLowerCase();
    expect(norm(loc.root)).toContain('git-tests');
    expect(norm(loc.gitDir)).toContain('/.git');
  });

  it('ローカルブランチを HEAD 印つきで返す', async () => {
    const branches = await listBranches(fx.ctx);
    expect(branches).toHaveLength(1);
    expect(branches[0]?.shortName).toBe('main');
    expect(branches[0]?.isHead).toBe(true);
    expect(branches[0]?.isRemote).toBe(false);
    expect(branches[0]?.upstream).toBeNull();
    expect(branches[0]?.subject).toBe('init');
    expect(branches[0]?.committedAt).not.toBe('');
  });

  it('複数ブランチを列挙し、現在のブランチだけ isHead になる', async () => {
    await fx.run('branch', 'feature/日本語ブランチ');
    await fx.run('branch', 'release-1.0');

    const branches = await listBranches(fx.ctx);
    const names = branches.map((b) => b.shortName).sort();
    expect(names).toEqual(['feature/日本語ブランチ', 'main', 'release-1.0']);
    expect(branches.filter((b) => b.isHead)).toHaveLength(1);
  });

  it('リモート未設定なら空配列を返す', async () => {
    expect(await listRemotes(fx.ctx)).toEqual([]);
  });

  it('上流の ahead / behind を取得する', async () => {
    // ローカルに疑似リモートを作って追跡させる
    const upstream = await createFixture();
    try {
      await upstream.write('u.txt', 'x');
      await commitAll(upstream, 'upstream init');
      await fx.run('remote', 'add', 'origin', upstream.dir);
      await fx.run('fetch', 'origin');
      await fx.run('branch', '--set-upstream-to=origin/main', 'main');

      await fx.write('b.txt', 'y');
      await commitAll(fx, 'local ahead');

      const branches = await listBranches(fx.ctx);
      const main = branches.find((b) => b.shortName === 'main');
      expect(main?.upstream).toBe('origin/main');
      expect(main?.ahead).toBeGreaterThanOrEqual(1);
      expect(await listRemotes(fx.ctx)).toEqual(['origin']);
    } finally {
      await upstream.cleanup();
    }
  });
});

describe('ブランチ切替 (対応表 #12)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
    await fx.write('a.txt', 'x');
    await commitAll(fx, 'init');
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('別のブランチへ切り替えると HEAD が移る', async () => {
    await fx.run('branch', 'feature');
    await switchBranch(fx.ctx, 'feature');

    const branches = await listBranches(fx.ctx);
    const feature = branches.find((b) => b.shortName === 'feature');
    expect(feature?.isHead).toBe(true);
  });

  it('リモートブランチを取り出すと上流つきのローカル枝ができる（対応表 #45）', async () => {
    const upstream = await createFixture();
    try {
      await upstream.write('u.txt', 'x');
      await commitAll(upstream, 'upstream init');
      await upstream.run('switch', '-c', 'feature/x');
      await upstream.write('f.txt', 'from feature');
      await commitAll(upstream, 'feature work');
      await upstream.run('switch', 'main');

      await fx.run('remote', 'add', 'origin', upstream.dir);
      await fx.run('fetch', 'origin');

      await switchToRemoteBranch(fx.ctx, 'origin/feature/x');

      const branches = await listBranches(fx.ctx);
      const local = branches.find((b) => b.shortName === 'feature/x' && !b.isRemote);
      expect(local?.isHead).toBe(true);
      // リモート名を除いた名前が付き、上流もそこへ張られる
      expect(local?.upstream).toBe('origin/feature/x');
    } finally {
      await upstream.cleanup();
    }
  });

  it('同名のローカルブランチが既にあると取り出しは失敗する（main が #12 に振り分ける根拠）', async () => {
    const upstream = await createFixture();
    try {
      await upstream.write('u.txt', 'x');
      await commitAll(upstream, 'upstream init');
      await upstream.run('switch', '-c', 'feature/x');
      await upstream.write('f.txt', 'from feature');
      await commitAll(upstream, 'feature work');
      await upstream.run('switch', 'main');

      await fx.run('remote', 'add', 'origin', upstream.dir);
      await fx.run('fetch', 'origin');
      await fx.run('branch', 'feature/x');

      await expect(switchToRemoteBranch(fx.ctx, 'origin/feature/x')).rejects.toBeInstanceOf(
        GitCommandError,
      );
    } finally {
      await upstream.cleanup();
    }
  });

  it('作業ツリーの変更が上書きされる場合は失敗する', async () => {
    await fx.run('branch', 'feature');
    await fx.run('switch', 'feature');
    await fx.write('a.txt', 'feature content');
    await fx.run('commit', '-am', 'feature change');
    await fx.run('switch', 'main');
    await fx.write('a.txt', 'uncommitted change');

    await expect(switchBranch(fx.ctx, 'feature')).rejects.toBeInstanceOf(GitCommandError);
  });
});

describe('ブランチ作成 (対応表 #14)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
    await fx.write('a.txt', 'x');
    await commitAll(fx, 'init');
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('起点を指定して作成すると、そこから分岐して切り替わる', async () => {
    await createBranch(fx.ctx, 'feature', 'main');

    const branches = await listBranches(fx.ctx);
    const feature = branches.find((b) => b.shortName === 'feature');
    expect(feature?.isHead).toBe(true);
    expect(feature?.oid).toBe(branches.find((b) => b.shortName === 'main')?.oid);
  });

  it('同名のブランチが既に存在すると失敗する', async () => {
    await fx.run('branch', 'feature');
    await expect(createBranch(fx.ctx, 'feature', 'main')).rejects.toBeInstanceOf(GitCommandError);
  });
});

describe('マージ (対応表 #35)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
    await fx.write('a.txt', 'base');
    await commitAll(fx, 'init');
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('fast-forward できるときは新しいコミットが取り込まれる', async () => {
    await createBranch(fx.ctx, 'feature', 'main');
    await fx.write('b.txt', 'from feature');
    await commitAll(fx, 'feature work');
    await switchBranch(fx.ctx, 'main');

    await mergeBranch(fx.ctx, 'feature');

    const branches = await listBranches(fx.ctx);
    const main = branches.find((b) => b.shortName === 'main');
    const feature = branches.find((b) => b.shortName === 'feature');
    // fast-forward なので main は feature と同じコミットを指す
    expect(main?.oid).toBe(feature?.oid);
  });

  it('両方が進んでいるときはマージコミットができる', async () => {
    await createBranch(fx.ctx, 'feature', 'main');
    await fx.write('b.txt', 'from feature');
    await commitAll(fx, 'feature work');
    await switchBranch(fx.ctx, 'main');
    await fx.write('c.txt', 'from main');
    await commitAll(fx, 'main work');

    await mergeBranch(fx.ctx, 'feature');

    const parents = (await fx.run('log', '-1', '--format=%P')).trim();
    // マージコミットは親が 2 つ
    expect(parents.split(' ')).toHaveLength(2);
  });

  it('コンフリクトすると失敗する（自動 abort はしない）', async () => {
    await createBranch(fx.ctx, 'feature', 'main');
    await fx.write('a.txt', 'feature side');
    await commitAll(fx, 'feature edit');
    await switchBranch(fx.ctx, 'main');
    await fx.write('a.txt', 'main side');
    await commitAll(fx, 'main edit');

    const error = await mergeBranch(fx.ctx, 'feature').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitCommandError);
    /*
     * 競合の説明は **stdout に出る**（stderr は空）。stderr しか持ち帰らないと
     * 「git の実行に失敗しました」としか言えないので、GitCommandError に stdout も載せる。
     */
    const failure = error as GitCommandError;
    expect(failure.stderr.trim()).toBe('');
    expect(failure.stdout).toMatch(/CONFLICT|Automatic merge failed/);

    // 競合したままの状態が残る（利用者が解決するか自分で abort する）
    const status = await fx.run('status', '--porcelain=v2', '-z');
    expect(status.startsWith('u ')).toBe(true);
  });

  it('存在しないブランチのマージは失敗する', async () => {
    await expect(mergeBranch(fx.ctx, 'nope')).rejects.toBeInstanceOf(GitCommandError);
  });
});
