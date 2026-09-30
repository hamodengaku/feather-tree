import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitCancelledError, GitCommandError, readBlobText, readHeadBlobFiltered, readWorktreeBytes } from '../src/index.js';
import { GIT_PATH, createFixture, type Fixture } from './fixture.js';

/*
 * 対応表 #49（`cat-file --filters HEAD:<path>`、決定 33）と、作業ツリーのバイト読みの統合テスト。実 git を使う。
 *
 * **Git LFS の代わりに、リポジトリ固有の偽のフィルタ（ftfake）を使う。** clean で `REAL` → `PTR` に、
 * smudge で `PTR` → `REAL` に書き換えるので、blob にはポインタ役の文字列が入り、チェックアウトすると
 * 実体役に戻る。LFS と同じ形を git-lfs 無しで作れる。名前を固有にするのは、開発機の global の
 * `filter.lfs` に左右されないため。設定はすべて `.tmp/` の使い捨てリポジトリのローカル設定に書く。
 */

const MAX = 1024 * 1024;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('HEAD 版の実体取得（対応表 #49）', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('バイナリをバイト単位でそのまま返す（NUL を含んでも捨てない）', async () => {
    const data = Uint8Array.from({ length: 4096 }, (_, i) => (i * 37) % 256);
    await fx.writeBytes('book.xlsx', data);
    await fx.run('add', 'book.xlsx');
    await fx.run('commit', '-m', 'first');

    const r = await readHeadBlobFiltered(fx.ctx, 'book.xlsx', { maxBytes: MAX });
    expect(r?.kind).toBe('ok');
    if (r?.kind !== 'ok') return;
    expect(Buffer.compare(r.bytes, Buffer.from(data))).toBe(0);
  });

  it('smudge を通す: show はポインタ、cat-file --filters は実体', async () => {
    await fx.run('config', 'filter.ftfake.clean', 'sed s/REAL/PTR/');
    await fx.run('config', 'filter.ftfake.smudge', 'sed s/PTR/REAL/');
    await fx.write('.gitattributes', '*.xlsx filter=ftfake\n');
    await fx.write('book.xlsx', 'REAL content\n');
    await fx.run('add', '-A');
    await fx.run('commit', '-m', 'first');

    expect((await readBlobText(fx.ctx, 'HEAD', 'book.xlsx'))?.text).toBe('PTR content\n');
    const r = await readHeadBlobFiltered(fx.ctx, 'book.xlsx', { maxBytes: MAX });
    expect(r?.kind === 'ok' ? text(r.bytes) : null).toBe('REAL content\n');
  });

  it('smudge が失敗したら（git-lfs が無い等）HEAD に無いとは言わずに失敗させる', async () => {
    await fx.write('book.xlsx', 'data\n');
    await fx.run('add', '-A');
    await fx.run('commit', '-m', 'first');
    // clean は素通し（git が作業ツリーを見直すときに clean を走らせても落ちないように）
    await fx.run('config', 'filter.ftfail.clean', 'cat');
    await fx.run('config', 'filter.ftfail.smudge', 'false');
    await fx.run('config', 'filter.ftfail.required', 'true');
    await fx.write('.gitattributes', '*.xlsx filter=ftfail\n');

    await expect(readHeadBlobFiltered(fx.ctx, 'book.xlsx', { maxBytes: MAX })).rejects.toBeInstanceOf(GitCommandError);
  });

  it('HEAD に無いパス・コミットが無いリポジトリは null', async () => {
    expect(await readHeadBlobFiltered(fx.ctx, 'book.xlsx', { maxBytes: MAX })).toBeNull();
    await fx.write('a.txt', 'a\n');
    await fx.run('add', '-A');
    await fx.run('commit', '-m', 'first');
    expect(await readHeadBlobFiltered(fx.ctx, 'new.xlsx', { maxBytes: MAX })).toBeNull();
  });

  it('上限を超えたら読むのをやめて too-large（プロセスは止まる）', async () => {
    await fx.write('big.xlsx', 'x'.repeat(300_000));
    await fx.run('add', '-A');
    await fx.run('commit', '-m', 'first');
    const r = await readHeadBlobFiltered(fx.ctx, 'big.xlsx', { maxBytes: 1000 });
    expect(r?.kind).toBe('too-large');
  });

  it('利用者の中止は GitCancelledError', async () => {
    await fx.write('a.xlsx', 'a');
    await fx.run('add', '-A');
    await fx.run('commit', '-m', 'first');
    const controller = new AbortController();
    controller.abort();
    await expect(
      readHeadBlobFiltered({ ...fx.ctx, signal: controller.signal }, 'a.xlsx', { maxBytes: MAX }),
    ).rejects.toBeInstanceOf(GitCancelledError);
  });
});

describe('作業ツリーのバイト読み（git は 0 プロセス）', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('読める・無ければ null・大きければ too-large', async () => {
    await fx.writeBytes('a.xlsx', bytes('hello'));
    const r = await readWorktreeBytes(fx.ctx, 'a.xlsx', { maxBytes: MAX });
    expect(r?.kind === 'ok' ? text(r.bytes) : null).toBe('hello');
    expect(await readWorktreeBytes(fx.ctx, 'missing.xlsx', { maxBytes: MAX })).toBeNull();
    expect((await readWorktreeBytes(fx.ctx, 'a.xlsx', { maxBytes: 2 }))?.kind).toBe('too-large');
  });

  it('ディレクトリは null', async () => {
    await fx.write('dir/x.txt', 'x');
    expect(await readWorktreeBytes(fx.ctx, 'dir', { maxBytes: MAX })).toBeNull();
  });
});

/*
 * 本物の Git LFS での確認（任意）。`FT_TEST_LFS=1` かつ git-lfs が入っているときだけ走る。
 * `git lfs install --local` を使う——global の設定を書き換える `git lfs install` は規約 2 で禁止。
 */
const lfsAvailable =
  process.env['FT_TEST_LFS'] === '1' && spawnSync(GIT_PATH, ['lfs', 'version'], { windowsHide: true }).status === 0;

describe.runIf(lfsAvailable)('本物の Git LFS（FT_TEST_LFS=1）', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('LFS 管理のファイルの HEAD 版は、ポインタではなく実体が返る', async () => {
    await fx.run('lfs', 'install', '--local');
    await fx.run('lfs', 'track', '*.xlsx');
    const data = Uint8Array.from({ length: 2048 }, (_, i) => (i * 13) % 256);
    await fx.writeBytes('book.xlsx', data);
    await fx.run('add', '-A');
    await fx.run('commit', '-m', 'first');

    expect((await readBlobText(fx.ctx, 'HEAD', 'book.xlsx'))?.text).toContain('git-lfs.github.com/spec');
    const r = await readHeadBlobFiltered(fx.ctx, 'book.xlsx', { maxBytes: MAX });
    expect(r?.kind === 'ok' ? Buffer.compare(r.bytes, Buffer.from(data)) : -1).toBe(0);
  });
});
