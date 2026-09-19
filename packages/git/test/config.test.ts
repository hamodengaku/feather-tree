import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readUserIdentity, setLocalUserIdentity } from '../src/index.js';
import type { GitContext } from '../src/index.js';
import { createFixture, type Fixture } from './fixture.js';

/*
 * 対応表 #42 〜 #44（コミット情報）。
 *
 * 期待値は実際の git で観察してから固定した（結果は docs/02-git-command-map.md の
 * #42〜#44 の表に残してある）。ここが崩れたら、まず git の出力形が変わったことを疑う。
 *
 * **global を書き換えるテストは書かない**（CLAUDE.md 規約 2: リポジトリ外を触らない）。
 * 「global から継承している」状態は GIT_CONFIG_GLOBAL で .tmp/ 内のファイルを
 * global の位置に差し込んで再現する。
 */
describe('コミット情報の読み書き (対応表 #42〜#44)', () => {
  let fx: Fixture;
  /** global の位置に差し込む設定ファイル（.tmp/ の中）。 */
  let fakeGlobal: string;

  beforeEach(async () => {
    fx = await createFixture();
    fakeGlobal = join(fx.dir, 'fake-global-config');
    await writeFile(
      fakeGlobal,
      '[user]\n\tname = Global Name\n\temail = global@example.invalid\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  /** global を差し替えた文脈。アプリ本体はこの env を付けない（テストだけの細工）。 */
  const withFakeGlobal = (): GitContext => ({
    ...fx.ctx,
    env: { GIT_CONFIG_GLOBAL: fakeGlobal },
  });

  it('ローカルに設定があれば local として返す', async () => {
    // createFixture が local に user.name / user.email を設定している
    const id = await readUserIdentity(fx.ctx);
    expect(id.name).toEqual({ value: 'FeatherTree Test', scope: 'local' });
    expect(id.email).toEqual({ value: 'test@example.invalid', scope: 'local' });
  });

  it('ローカルに無く global にあれば inherited として返す（警告を出すための区別）', async () => {
    await fx.run('config', '--local', '--unset', 'user.name');
    await fx.run('config', '--local', '--unset', 'user.email');

    const id = await readUserIdentity(withFakeGlobal());
    expect(id.name).toEqual({ value: 'Global Name', scope: 'inherited' });
    expect(id.email).toEqual({ value: 'global@example.invalid', scope: 'inherited' });
  });

  it('どこにも無ければ unset（一致 0 件の終了コード 1 を失敗にしない）', async () => {
    await fx.run('config', '--local', '--unset', 'user.name');
    await fx.run('config', '--local', '--unset', 'user.email');

    // global も system も見えない文脈にする
    const isolated: GitContext = {
      ...fx.ctx,
      env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    };
    const id = await readUserIdentity(isolated);
    expect(id.name).toEqual({ value: null, scope: 'unset' });
    expect(id.email).toEqual({ value: null, scope: 'unset' });
  });

  it('片方だけローカルにある場合、もう片方だけ継承として返す', async () => {
    await fx.run('config', '--local', '--unset', 'user.email');

    const id = await readUserIdentity(withFakeGlobal());
    expect(id.name).toEqual({ value: 'FeatherTree Test', scope: 'local' });
    expect(id.email).toEqual({ value: 'global@example.invalid', scope: 'inherited' });
  });

  it('書いたらローカルとして読み戻せる（global より優先される）', async () => {
    await setLocalUserIdentity(fx.ctx, 'name', '山田 太郎');
    await setLocalUserIdentity(fx.ctx, 'email', 'taro+ft@example.invalid');

    const id = await readUserIdentity(withFakeGlobal());
    expect(id.name).toEqual({ value: '山田 太郎', scope: 'local' });
    expect(id.email).toEqual({ value: 'taro+ft@example.invalid', scope: 'local' });
  });

  it('空白・= を含む値も往復する', async () => {
    await setLocalUserIdentity(fx.ctx, 'name', 'A B = C');
    const id = await readUserIdentity(fx.ctx);
    expect(id.name.value).toBe('A B = C');
  });

  it('値に改行が入っても、キーと値の境界を取り違えない（最初の改行だけで割る）', async () => {
    // アプリは改行を含む値を保存させない（core の検証で弾く）が、手で書かれた
    // .git/config にはありうる。読みで壊れないことを確かめる。
    await fx.run('config', '--local', 'user.name', 'first\nsecond');

    const id = await readUserIdentity(fx.ctx);
    expect(id.name).toEqual({ value: 'first\nsecond', scope: 'local' });
    // 隣のキーを巻き込んでいないこと
    expect(id.email.value).toBe('test@example.invalid');
  });

  it('先頭が - の値も、オプションではなく値として保存される（-- を置いている）', async () => {
    await setLocalUserIdentity(fx.ctx, 'name', '-weird');
    const id = await readUserIdentity(fx.ctx);
    expect(id.name).toEqual({ value: '-weird', scope: 'local' });
  });
});
