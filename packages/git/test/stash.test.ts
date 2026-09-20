import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitCommandError,
  applyStash,
  dropStash,
  getStashFileDiff,
  getStashFiles,
  listStashes,
  parseStashList,
  pushStagedStash,
} from '../src/index.js';
import { createFixture, type Fixture } from './fixture.js';

const LF = String.fromCharCode(10);
const US = String.fromCharCode(0x1f);
const NUL = String.fromCharCode(0);

/**
 * stash（決定 31 / 対応表 #27〜#31、#45、#46）。
 *
 * **このファイルは docs/02-git-command-map.md #27 の実測表の写し**である。
 * あの表は「なぜ `--staged` なのか」「なぜ失敗しても取り直すのか」の根拠なので、
 * git 側の挙動が変わったらここが落ちて気づけるようにしてある。
 */
describe('stash (対応表 #27〜#31、#45、#46)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
    await fx.write('tracked.txt', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join(LF) + LF);
    await fx.write('other.txt', 'x' + LF);
    await fx.run('add', '-A');
    await fx.run('commit', '-m', 'init');
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  const read = (rel: string): Promise<string> => readFile(join(fx.dir, rel), 'utf8');
  const exists = (rel: string): boolean => existsSync(join(fx.dir, rel));

  describe('#27 push --staged: ステージした差分だけを退避する', () => {
    it('ステージ済みだけのファイルは、index からも作業ツリーからも消える', async () => {
      await fx.write('tracked.txt', ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h'].join(LF) + LF);
      await fx.run('add', 'tracked.txt');

      await pushStagedStash(fx.ctx, '退避その 1');

      expect(await read('tracked.txt')).toContain('a' + LF + 'b' + LF);
      const list = await listStashes(fx.ctx);
      expect(list).toHaveLength(1);
      expect(list[0]?.message).toContain('退避その 1');
      // --staged の stash は親が 2 つ（HEAD と index コミット）。3 つ目の未追跡コミットは無い
      expect(list[0]?.parents).toHaveLength(2);
    });

    it('git add 済みの未追跡ファイルも入り、ディスクからも消える（追跡／未追跡を問わない）', async () => {
      await fx.write('added.txt', 'new' + LF);
      await fx.run('add', 'added.txt');

      await pushStagedStash(fx.ctx, '未追跡も');

      expect(exists('added.txt')).toBe(false);
      const files = await getStashFiles(fx.ctx, (await listStashes(fx.ctx))[0]?.oid ?? '');
      expect(files).toEqual([{ status: 'A', path: 'added.txt', origPath: null }]);
    });

    it('ステージしていないもの（未ステージ・完全な未追跡）は動かさない', async () => {
      await fx.write('tracked.txt', ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join(LF) + LF);
      await fx.run('add', 'tracked.txt');
      // 以下はステージしない
      await fx.write('other.txt', 'x' + LF + 'y' + LF);
      await fx.write('loose.txt', 'untracked' + LF);

      await pushStagedStash(fx.ctx, 'ステージ分だけ');

      expect(await read('other.txt')).toBe('x' + LF + 'y' + LF);
      expect(await read('loose.txt')).toBe('untracked' + LF);
      const files = await getStashFiles(fx.ctx, (await listStashes(fx.ctx))[0]?.oid ?? '');
      expect(files.map((f) => f.path)).toEqual(['tracked.txt']);
    });

    it('同じファイルの離れた行なら、ステージ分だけが退避され未ステージ分は残る', async () => {
      const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
      await fx.write('tracked.txt', [...base.slice(0, 1), 'STAGED', ...base.slice(2)].join(LF) + LF);
      await fx.run('add', 'tracked.txt');
      await fx.write(
        'tracked.txt',
        [...base.slice(0, 1), 'STAGED', ...base.slice(2, 7), 'WORKTREE'].join(LF) + LF,
      );

      await pushStagedStash(fx.ctx, '離れた行');

      const after = await read('tracked.txt');
      // ステージした行は元に戻り、未ステージの行だけが残る
      expect(after).toContain('b' + LF);
      expect(after).not.toContain('STAGED');
      expect(after).toContain('WORKTREE');
    });

    /*
     * docs/02-git-command-map.md #27 の実測表 5 行目。**失敗しても stash はできている。**
     * これが「失敗の側でも #2 / #28 を取り直す」根拠なので、挙動が変わったら気づきたい。
     */
    it('ステージ分と未ステージ分が近接していると失敗するが、stash だけはできている', async () => {
      await fx.write('near.txt', ['a', 'b', 'c'].join(LF) + LF);
      await fx.run('add', '-A');
      await fx.run('commit', '-m', 'near');
      await fx.write('near.txt', ['a', 'B', 'c'].join(LF) + LF);
      await fx.run('add', 'near.txt');
      await fx.write('near.txt', ['a', 'B', 'C'].join(LF) + LF);

      await expect(pushStagedStash(fx.ctx, '近接')).rejects.toBeInstanceOf(GitCommandError);

      // 作業ツリーは動いていないのに stash は積まれている
      expect(await read('near.txt')).toBe(['a', 'B', 'C'].join(LF) + LF);
      expect(await listStashes(fx.ctx)).toHaveLength(1);
    });

    it('ステージが 1 つも無ければ失敗し、stash は作られない', async () => {
      await fx.write('tracked.txt', 'changed' + LF);

      // 例外の message は定型文なので、git の言い分は stderr で見る
      const failure = await pushStagedStash(fx.ctx, '何も無い').catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(GitCommandError);
      expect((failure as GitCommandError).stderr).toMatch(/No staged changes/i);
      expect(await listStashes(fx.ctx)).toHaveLength(0);
    });
  });

  describe('#28 list: 参照の 2 本立て', () => {
    it('番号は drop でずれるが、oid はずれない', async () => {
      for (const name of ['one', 'two', 'three']) {
        await fx.write('tracked.txt', name + LF);
        await fx.run('add', 'tracked.txt');
        await pushStagedStash(fx.ctx, name);
      }

      const before = await listStashes(fx.ctx);
      expect(before.map((s) => s.ref)).toEqual(['stash@{0}', 'stash@{1}', 'stash@{2}']);
      // 新しいものが 0 番
      expect(before[0]?.message).toContain('three');
      const oldest = before[2];
      expect(oldest).toBeDefined();

      await dropStash(fx.ctx, 1);

      const after = await listStashes(fx.ctx);
      expect(after).toHaveLength(2);
      // 同じ stash が 2 番から 1 番へずれた。oid は変わらない
      expect(after[1]?.oid).toBe(oldest?.oid);
      expect(after[1]?.ref).toBe('stash@{1}');
    });

    it('stash が無ければ空配列（エラーにしない）', async () => {
      expect(await listStashes(fx.ctx)).toEqual([]);
    });
  });

  describe('#29 / #30 apply / pop', () => {
    it('apply は展開して stash を残し、pop は展開して消す', async () => {
      await fx.write('tracked.txt', 'applied' + LF);
      await fx.run('add', 'tracked.txt');
      await pushStagedStash(fx.ctx, '展開する');

      await applyStash(fx.ctx, 0, false);
      expect(await read('tracked.txt')).toBe('applied' + LF);
      expect(await listStashes(fx.ctx)).toHaveLength(1);

      // 同じ内容なので、元へ戻してから pop を試す
      await fx.run('checkout', '--', 'tracked.txt');
      await applyStash(fx.ctx, 0, true);
      expect(await read('tracked.txt')).toBe('applied' + LF);
      expect(await listStashes(fx.ctx)).toHaveLength(0);
    });

    /*
     * 決定 31 の根拠。`--index` を付けないので、戻ってくる変更は未ステージになる。
     * ここが変わると UI の文言（「未ステージとして戻ります」）が嘘になる。
     */
    it('--index を付けないので、戻ってきた変更は未ステージになる', async () => {
      await fx.write('tracked.txt', 'unstaged-after-pop' + LF);
      await fx.run('add', 'tracked.txt');
      await pushStagedStash(fx.ctx, 'ステージ状態は戻らない');

      await applyStash(fx.ctx, 0, true);

      const status = await fx.run('status', '--porcelain=v2');
      // XY の X（index 側）が '.' ＝ ステージされていない
      expect(status).toMatch(/^1 \.M/m);
    });
  });

  describe('#31 drop', () => {
    it('指定した 1 件だけを消す', async () => {
      for (const name of ['one', 'two']) {
        await fx.write('tracked.txt', name + LF);
        await fx.run('add', 'tracked.txt');
        await pushStagedStash(fx.ctx, name);
      }

      await dropStash(fx.ctx, 0);

      const after = await listStashes(fx.ctx);
      expect(after).toHaveLength(1);
      expect(after[0]?.message).toContain('one');
    });

    it('存在しない番号は失敗する（git の ref 検証に任せる）', async () => {
      await expect(dropStash(fx.ctx, 5)).rejects.toBeInstanceOf(GitCommandError);
    });

    it('負の番号は git を起動せずに拒否する', async () => {
      await expect(dropStash(fx.ctx, -1)).rejects.toBeInstanceOf(RangeError);
    });
  });

  describe('#45 / #46 中身の読み取り', () => {
    it('変更ファイル一覧と、その 1 ファイルの diff を oid で取れる', async () => {
      await fx.write('tracked.txt', ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h'].join(LF) + LF);
      await fx.write('fresh.txt', 'fresh' + LF);
      await fx.run('add', '-A');
      await pushStagedStash(fx.ctx, '中身を読む');

      const entry = (await listStashes(fx.ctx))[0];
      expect(entry).toBeDefined();
      const oid = entry?.oid ?? '';

      const files = await getStashFiles(fx.ctx, oid);
      expect(files.map((f) => f.path).sort()).toEqual(['fresh.txt', 'tracked.txt']);

      const diff = await getStashFileDiff(fx.ctx, oid, 'tracked.txt', { contextLines: 3 });
      expect(diff?.path).toBe('tracked.txt');
      const texts = diff?.hunks.flatMap((h) => h.lines.map((l) => l.kind + l.text)) ?? [];
      expect(texts).toContain('removedb');
      expect(texts).toContain('addedB');
    });

    it('その stash に無いファイルは null（別の stash の中身を出さない）', async () => {
      await fx.write('tracked.txt', 'only-this' + LF);
      await fx.run('add', 'tracked.txt');
      await pushStagedStash(fx.ctx, '1 ファイルだけ');

      const oid = (await listStashes(fx.ctx))[0]?.oid ?? '';
      expect(await getStashFileDiff(fx.ctx, oid, 'other.txt')).toBeNull();
    });

    /*
     * 外部で `-u` 付きに作られた stash（親が 3 つ）。未追跡としてだけ入っている
     * ファイルは第 1 親との diff に出てこないので、第 3 親を相手に打ち直す
     * （docs/02-git-command-map.md #46 の注記）。
     */
    it('外部の -u 付き stash は、未追跡分が第 3 親にしか無い', async () => {
      await fx.write('tracked.txt', 'modified' + LF);
      await fx.write('loose.txt', 'brand new' + LF);
      await fx.run('stash', 'push', '--include-untracked', '--message=外部');

      const entry = (await listStashes(fx.ctx))[0];
      expect(entry?.parents).toHaveLength(3);
      const oid = entry?.oid ?? '';

      // 一覧には出る（--include-untracked を付けているため）
      const files = await getStashFiles(fx.ctx, oid);
      expect(files.map((f) => f.path).sort()).toEqual(['loose.txt', 'tracked.txt']);

      // が、第 1 親との diff には出ない。第 3 親を相手にすると出る
      expect(await getStashFileDiff(fx.ctx, oid, 'loose.txt')).toBeNull();
      const viaThird = await getStashFileDiff(fx.ctx, oid, 'loose.txt', { fromUntracked: true });
      expect(viaThird?.path).toBe('loose.txt');
    });
  });
});

describe('parseStashList', () => {
  const record = (...fields: readonly string[]): string => fields.join(US) + NUL + LF;

  it('番号・oid・親・日時・件名を取り出す', () => {
    const out =
      record('stash@{0}', 'aaa', 'p1 p2', '2026-09-20T08:00:00+09:00', 'On main: 新しい') +
      record('stash@{1}', 'bbb', 'p1 p2 p3', '2026-09-19T08:00:00+09:00', 'On main: 古い');

    expect(parseStashList(out)).toEqual([
      {
        index: 0,
        ref: 'stash@{0}',
        oid: 'aaa',
        parents: ['p1', 'p2'],
        authoredAt: '2026-09-20T08:00:00+09:00',
        message: 'On main: 新しい',
      },
      {
        index: 1,
        ref: 'stash@{1}',
        oid: 'bbb',
        parents: ['p1', 'p2', 'p3'],
        authoredAt: '2026-09-19T08:00:00+09:00',
        message: 'On main: 古い',
      },
    ]);
  });

  /*
   * `%gs` は改行を空白へ潰すが US はそのまま通す（実測）。件名は最後のフィールドなので、
   * 繋ぎ直して欠けないようにしてある。メッセージの検証は main 側の責務で、
   * ここは「検証をすり抜けた値でも一覧が壊れない」ことの担保。
   */
  it('件名に US が紛れ込んでも欠けない', () => {
    const out = record('stash@{0}', 'aaa', 'p1 p2', '2026-09-20T08:00:00+09:00', 'On main: a' + US + 'b');
    expect(parseStashList(out)[0]?.message).toBe('On main: a' + US + 'b');
  });

  it('番号の形が読めない行は捨てる（並び順で番号を補わない）', () => {
    const out =
      record('stash@{0}', 'aaa', 'p1 p2', '2026-09-20T08:00:00+09:00', 'まとも') +
      record('refs/stash', 'bbb', 'p1 p2', '2026-09-19T08:00:00+09:00', '番号が無い') +
      record('stash@{2}', 'ccc', 'p1 p2', '2026-09-18T08:00:00+09:00', 'まとも');

    const parsed = parseStashList(out);
    expect(parsed.map((s) => s.index)).toEqual([0, 2]);
  });

  it('空の出力は空配列', () => {
    expect(parseStashList('')).toEqual([]);
  });
});
