import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCommitFiles, getLog } from '../src/index.js';
import { commitAll, createFixture, type Fixture } from './fixture.js';

describe('履歴 (対応表 #20 / #21)', () => {
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
