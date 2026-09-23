import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBlobText } from '../src/index.js';
import { createFixture, type Fixture } from './fixture.js';

/*
 * 対応表 #48（`show <rev>:<path>`、決定 32）の統合テスト。実 git を使う。
 *
 * ここが返すのは**smudge フィルタも改行変換も通していない生の blob**。
 * 作業ツリーの中身と一致するとは限らないことを、CRLF のケースで明示しておく
 * （その食い違いの扱いは unity 層の verifyAlignment / F-6）。
 */

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

describe('blob の全文取得（対応表 #48）', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('HEAD と index のそれぞれから読める', async () => {
    await fx.write('a.prefab', 'one' + LF);
    await fx.run('add', 'a.prefab');
    await fx.run('commit', '-m', 'first');

    await fx.write('a.prefab', 'two' + LF);
    await fx.run('add', 'a.prefab');

    expect((await readBlobText(fx.ctx, 'HEAD', 'a.prefab'))?.text).toBe('one' + LF);
    expect((await readBlobText(fx.ctx, 'index', 'a.prefab'))?.text).toBe('two' + LF);
  });

  it('未ステージの編集は index 側には出ない（読むのはあくまで blob）', async () => {
    await fx.write('a.prefab', 'one' + LF);
    await fx.run('add', 'a.prefab');
    await fx.run('commit', '-m', 'first');
    await fx.write('a.prefab', 'edited' + LF);

    expect((await readBlobText(fx.ctx, 'index', 'a.prefab'))?.text).toBe('one' + LF);
  });

  it('その版に無いパスは null（新規ファイルの旧側）', async () => {
    await fx.write('a.prefab', 'one' + LF);
    await fx.run('add', 'a.prefab');
    await fx.run('commit', '-m', 'first');

    await fx.write('new.prefab', 'fresh' + LF);
    await fx.run('add', 'new.prefab');

    expect(await readBlobText(fx.ctx, 'HEAD', 'new.prefab')).toBeNull();
    expect((await readBlobText(fx.ctx, 'index', 'new.prefab'))?.text).toBe('fresh' + LF);
  });

  it('コミットが 1 つも無いリポジトリでも落ちない', async () => {
    await fx.write('a.prefab', 'one' + LF);
    await fx.run('add', 'a.prefab');

    expect(await readBlobText(fx.ctx, 'HEAD', 'a.prefab')).toBeNull();
    expect((await readBlobText(fx.ctx, 'index', 'a.prefab'))?.text).toBe('one' + LF);
  });

  it('日本語のファイル名と中身を壊さない', async () => {
    const body = 'プレハブ' + LF + '日本語' + LF;
    await fx.write('資材/主人公.prefab', body);
    await fx.run('add', '.');
    await fx.run('commit', '-m', 'ja');

    expect((await readBlobText(fx.ctx, 'HEAD', '資材/主人公.prefab'))?.text).toBe(body);
  });

  it('バイナリは文字列にせず null を返す（100MB を一度 UTF-8 にしないため）', async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]).toString('binary');
    await fx.write('a.bin', binary);
    await fx.run('add', 'a.bin');
    await fx.run('commit', '-m', 'bin');

    const blob = await readBlobText(fx.ctx, 'HEAD', 'a.bin');
    expect(blob?.text).toBeNull();
    expect(blob?.bytes).toBeGreaterThan(0);
  });

  it('core.autocrlf=true では blob が LF のまま返る（F-6 の食い違いの素）', async () => {
    await fx.run('config', 'core.autocrlf', 'true');
    await fx.write('a.prefab', 'one' + CRLF + 'two' + CRLF);
    await fx.run('add', 'a.prefab');
    await fx.run('commit', '-m', 'crlf');

    // index の中身は LF に正規化されている。作業ツリーは CRLF のまま。
    // この食い違いを見逃すと「押した行とは別の場所が index に入る」ので、
    // unity 層の verifyAlignment がここを検査する
    expect((await readBlobText(fx.ctx, 'HEAD', 'a.prefab'))?.text).toBe('one' + LF + 'two' + LF);
  });
});
