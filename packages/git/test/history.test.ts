import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCommitFileDiff, getCommitFiles, getLog } from '../src/index.js';
import { commitAll, createFixture, type Fixture } from './fixture.js';

describe('履歴 (対応表 #20 / #21 / #36)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('コミットが無いリポジトリでは空配列を返す（例外にしない）', async () => {
    expect(await getLog(fx.ctx)).toEqual([]);
  });

  it('件名・作者・親を取得する', async () => {
    await fx.write('a.txt', 'x');
    await commitAll(fx, '最初のコミット');
    await fx.write('b.txt', 'y');
    await commitAll(fx, '2 番目のコミット');

    const log = await getLog(fx.ctx);
    expect(log).toHaveLength(2);
    expect(log[0]?.subject).toBe('2 番目のコミット');
    expect(log[1]?.subject).toBe('最初のコミット');
    expect(log[0]?.authorName).toBe('FeatherTree Test');
    expect(log[0]?.authorEmail).toBe('test@example.invalid');
    expect(log[0]?.parents).toEqual([log[1]?.oid]);
    expect(log[1]?.parents).toEqual([]);
    expect(log[0]?.shortOid.length).toBeGreaterThan(4);
    expect(log[0]?.authoredAt).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
  });

  it('区切り文字を含む件名でもフィールドがずれない', async () => {
    await fx.write('a.txt', 'x');
    // パイプ・タブ・引用符など、素朴な区切りだと壊れる文字を含める
    await commitAll(fx, 'fix: a|b\tc "d" (e) 日本語');

    const log = await getLog(fx.ctx);
    expect(log[0]?.subject).toBe('fix: a|b\tc "d" (e) 日本語');
  });

  it('maxCount と skip でページングできる', async () => {
    for (let i = 0; i < 5; i += 1) {
      await fx.write('a.txt', String(i));
      await commitAll(fx, `c${String(i)}`);
    }

    const first = await getLog(fx.ctx, { maxCount: 2 });
    const second = await getLog(fx.ctx, { maxCount: 2, skip: 2 });
    expect(first.map((c) => c.subject)).toEqual(['c4', 'c3']);
    expect(second.map((c) => c.subject)).toEqual(['c2', 'c1']);
  });

  it('コミットの変更ファイル一覧を取得する', async () => {
    await fx.write('a.txt', 'x');
    await fx.write('日本語 ファイル.txt', 'y');
    await commitAll(fx, 'init');

    const oid = (await fx.run('rev-parse', 'HEAD')).trim();
    const files = await getCommitFiles(fx.ctx, oid);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(['a.txt', '日本語 ファイル.txt']);
    expect(files.every((f) => f.status === 'A')).toBe(true);
  });

  it('本文（%b）とコミッターを取得する', async () => {
    await fx.write('a.txt', 'x');
    await fx.run('add', '-A');
    // 件名の後に空行、そして複数行の本文。本文は最後のフィールドなので改行を含んでよい
    await fx.run('commit', '-m', '件名', '-m', '1 行目\n2 行目');

    const log = await getLog(fx.ctx);
    expect(log[0]?.subject).toBe('件名');
    expect(log[0]?.body).toBe('1 行目\n2 行目');
    expect(log[0]?.committerName).toBe('FeatherTree Test');
    expect(log[0]?.committerEmail).toBe('test@example.invalid');
    expect(log[0]?.committedAt).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
  });

  it('本文が無いコミットの本文は空文字（末尾の改行を残さない）', async () => {
    await fx.write('a.txt', 'x');
    await commitAll(fx, '件名だけ');

    expect((await getLog(fx.ctx))[0]?.body).toBe('');
  });

  it('本文が複数行でもレコードの境界が壊れない（次のコミットが欠けない）', async () => {
    await fx.write('a.txt', 'x');
    await fx.run('add', '-A');
    await fx.run('commit', '-m', '1 つ目', '-m', 'あ\n\nい\nう');
    await fx.write('b.txt', 'y');
    await commitAll(fx, '2 つ目');

    const log = await getLog(fx.ctx);
    expect(log.map((c) => c.subject)).toEqual(['2 つ目', '1 つ目']);
    expect(log[1]?.body).toBe('あ\n\nい\nう');
  });

  it('--all なので、チェックアウトしていないブランチのコミットも出る', async () => {
    await fx.write('a.txt', 'x');
    await commitAll(fx, '共通');
    // main から分岐して 1 コミットし、main へ戻る。feature は未マージのまま
    await fx.run('switch', '-c', 'feature');
    await fx.write('b.txt', 'y');
    await commitAll(fx, 'feature だけのコミット');
    await fx.run('switch', 'main');

    const subjects = (await getLog(fx.ctx)).map((c) => c.subject);
    expect(subjects).toContain('feature だけのコミット');
    expect(subjects).toContain('共通');
  });

  it('コミット内の 1 ファイルの diff を取得する (#36)', async () => {
    await fx.write('a.txt', 'one\ntwo\n');
    await fx.write('b.txt', 'other\n');
    await commitAll(fx, 'init');
    await fx.write('a.txt', 'one\nCHANGED\n');
    await commitAll(fx, 'edit');

    const oid = (await fx.run('rev-parse', 'HEAD')).trim();
    const diff = await getCommitFileDiff(fx.ctx, oid, 'a.txt');

    expect(diff?.path).toBe('a.txt');
    expect(diff?.hunks.length).toBeGreaterThan(0);
    const texts = diff?.hunks.flatMap((h) => h.lines).map((l) => `${l.kind}:${l.text}`) ?? [];
    expect(texts).toContain('removed:two');
    expect(texts).toContain('added:CHANGED');
  });

  it('そのコミットで変わっていないファイルを指定すると null', async () => {
    await fx.write('a.txt', 'x');
    await fx.write('b.txt', 'y');
    await commitAll(fx, 'init');
    await fx.write('a.txt', 'z');
    await commitAll(fx, 'edit a');

    const oid = (await fx.run('rev-parse', 'HEAD')).trim();
    expect(await getCommitFileDiff(fx.ctx, oid, 'b.txt')).toBeNull();
  });

  /*
   * マージコミットは git の既定で diff を出さない（-m / -c / --cc が無いため）。
   * アプリ側で -m を足して取り繕わないことを、ここで固定しておく（決定 6）。
   * 画面には「マージコミットのため変更ファイルはありません」と出す。
   */
  it('マージコミットでは変更ファイルも diff も空になる（git の既定）', async () => {
    await fx.write('base.txt', 'base');
    await commitAll(fx, 'base');
    await fx.run('switch', '-c', 'feature');
    await fx.write('f.txt', 'f');
    await commitAll(fx, 'feature');
    await fx.run('switch', 'main');
    await fx.write('m.txt', 'm');
    await commitAll(fx, 'main');
    await fx.run('merge', '--no-ff', '-m', 'マージ', 'feature');

    const oid = (await fx.run('rev-parse', 'HEAD')).trim();
    const merge = (await getLog(fx.ctx)).find((c) => c.oid === oid);
    expect(merge?.parents).toHaveLength(2);

    expect(await getCommitFiles(fx.ctx, oid)).toEqual([]);
    expect(await getCommitFileDiff(fx.ctx, oid, 'f.txt')).toBeNull();
  });

  it('リネームコミットで元パスと新パスの両方を返す', async () => {
    await fx.write('old.txt', 'z'.repeat(200));
    await commitAll(fx, 'init');
    await fx.run('mv', 'old.txt', 'new.txt');
    await commitAll(fx, 'rename');

    const oid = (await fx.run('rev-parse', 'HEAD')).trim();
    const files = await getCommitFiles(fx.ctx, oid);
    const renamed = files.find((f) => f.status.startsWith('R'));
    expect(renamed?.origPath).toBe('old.txt');
    expect(renamed?.path).toBe('new.txt');
  });
});
