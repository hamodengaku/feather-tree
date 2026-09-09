import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitCancelledError, GitNotFoundError, getGitVersion, getStatus, runGitText } from '../src/index.js';
import { READ_PREFIX } from '../src/index.js';
import { commitAll, createFixture, GIT_PATH, type Fixture } from './fixture.js';

describe('プロセス実行 (execution 層)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('git のバージョンを取得する', async () => {
    const v = await getGitVersion(GIT_PATH, fx.dir);
    expect(v.raw).toContain('git version');
    expect(v.major).toBeGreaterThanOrEqual(2);
    // --pathspec-from-file は 2.25 以降
    expect(v.major > 2 || v.minor >= 25).toBe(true);
  });

  it('存在しない git.exe は GitNotFoundError になる', async () => {
    await expect(
      runGitText({ gitPath: 'no-such-git-binary-xyz', cwd: fx.dir, args: ['--version'] }),
    ).rejects.toBeInstanceOf(GitNotFoundError);
  });

  it('引数を配列で渡すのでシェル解釈が起きない', async () => {
    // シェルなら展開・連結される文字列をファイル名として扱えること
    // cmd.exe なら & で分割、^ でエスケープ、%PATH% を展開、! を遅延展開する文字列。
    // Windows のファイル名に使えない > < | : " ? * は避ける。
    const tricky = 'a & b ^ c (1) %PATH% !x!.txt';
    await fx.write(tricky, 'x');
    const s = await getStatus(fx.ctx);
    expect(s.entries.map((e) => e.path)).toContain(tricky);
  });

  it('キャンセルで GitCancelledError になり、プロセスが残らない', async () => {
    await fx.write('a.txt', 'x');
    await commitAll(fx, 'init');

    const controller = new AbortController();
    const promise = runGitText(
      { gitPath: GIT_PATH, cwd: fx.dir, args: [...READ_PREFIX, 'log', '--format=%H'] },
      controller.signal,
    );
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(GitCancelledError);
  });

  it('開始前に abort 済みでも安全に中断する', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runGitText({ gitPath: GIT_PATH, cwd: fx.dir, args: ['--version'] }, controller.signal),
    ).rejects.toBeInstanceOf(GitCancelledError);
  });

  it('stderr を保持し、終了コードを返す', async () => {
    const { exit } = await runGitText({
      gitPath: GIT_PATH,
      cwd: fx.dir,
      args: [...READ_PREFIX, 'rev-parse', 'no-such-ref-xyz'],
    });
    expect(exit.code).not.toBe(0);
    expect(exit.stderr.length).toBeGreaterThan(0);
    expect(exit.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
