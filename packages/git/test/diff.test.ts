import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getFileDiff, getStatus, getUntrackedFileDiff } from '../src/index.js';
import { commitAll, createFixture, type Fixture } from './fixture.js';

const LF = String.fromCharCode(10);

describe('diff (対応表 #18 / #19)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('未ステージの変更を行番号つきで返す', async () => {
    await fx.write('a.txt', ['one', 'two', 'three'].join(LF) + LF);
    await commitAll(fx, 'init');
    await fx.write('a.txt', ['one', 'TWO', 'three'].join(LF) + LF);

    const diff = await getFileDiff(fx.ctx, 'a.txt', false);
    expect(diff).not.toBeNull();
    expect(diff?.binary).toBe(false);
    expect(diff?.hunks).toHaveLength(1);

    const lines = diff?.hunks[0]?.lines ?? [];
    const removed = lines.find((l) => l.kind === 'removed');
    const added = lines.find((l) => l.kind === 'added');
    expect(removed?.text).toBe('two');
    expect(removed?.oldLineNo).toBe(2);
    expect(removed?.newLineNo).toBeNull();
    expect(added?.text).toBe('TWO');
    expect(added?.newLineNo).toBe(2);
    expect(lines.filter((l) => l.kind === 'context')).toHaveLength(2);
  });

  it('ステージ済みの変更は --cached 側で返る', async () => {
    await fx.write('a.txt', 'one' + LF);
    await commitAll(fx, 'init');
    await fx.write('a.txt', 'staged' + LF);
    await fx.run('add', 'a.txt');

    const staged = await getFileDiff(fx.ctx, 'a.txt', true);
    const unstaged = await getFileDiff(fx.ctx, 'a.txt', false);
    expect(staged?.hunks).toHaveLength(1);
    expect(unstaged).toBeNull();
  });

  it('日本語ファイル名・日本語内容を扱える', async () => {
    await fx.write('日本語 ファイル.txt', 'あいうえお' + LF);
    await commitAll(fx, 'init');
    await fx.write('日本語 ファイル.txt', 'かきくけこ' + LF);

    const diff = await getFileDiff(fx.ctx, '日本語 ファイル.txt', false);
    expect(diff?.path).toBe('日本語 ファイル.txt');
    const lines = diff?.hunks[0]?.lines ?? [];
    expect(lines.find((l) => l.kind === 'removed')?.text).toBe('あいうえお');
    expect(lines.find((l) => l.kind === 'added')?.text).toBe('かきくけこ');
  });

  it('バイナリファイルは binary として返す', async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]);
    await fx.write('bin.dat', bytes.toString('latin1'));
    await commitAll(fx, 'init');
    await fx.write('bin.dat', Buffer.from([0x00, 0x09, 0x02, 0xfe, 0x00]).toString('latin1'));

    const diff = await getFileDiff(fx.ctx, 'bin.dat', false);
    expect(diff?.binary).toBe(true);
    expect(diff?.hunks).toHaveLength(0);
  });

  it('未追跡ファイルは git を呼ばず全行追加として表示する', async () => {
    await fx.write('new.txt', ['a', 'b', 'c'].join(LF) + LF);

    const diff = await getUntrackedFileDiff(fx.ctx, 'new.txt');
    expect(diff.binary).toBe(false);
    expect(diff.hunks[0]?.lines).toHaveLength(3);
    expect(diff.hunks[0]?.lines.every((l) => l.kind === 'added')).toBe(true);
    expect(diff.hunks[0]?.lines[2]?.newLineNo).toBe(3);
  });

  it('未追跡のバイナリは内容を読み込まずバイナリ扱いにする', async () => {
    await fx.write('new.bin', Buffer.from([0x41, 0x00, 0x42]).toString('latin1'));
    const diff = await getUntrackedFileDiff(fx.ctx, 'new.bin');
    expect(diff.binary).toBe(true);
    expect(diff.hunks).toHaveLength(0);
  });

  it('入れ子のリポジトリ（all でも dir/ で来る）は EISDIR にせず差分なしで返す', async () => {
    await fx.write('nested/a.txt', 'x' + LF);
    await fx.run('init', '--quiet', 'nested');

    const status = await getStatus(fx.ctx);
    expect(status.entries.map((e) => e.path)).toEqual(['nested/']);

    const diff = await getUntrackedFileDiff(fx.ctx, 'nested/');
    expect(diff.binary).toBe(false);
    expect(diff.hunks).toHaveLength(0);
  });

  it('行数上限を超えたら打ち切って truncated を立てる', async () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${String(i)}`).join(LF) + LF;
    await fx.write('big.txt', many);

    const diff = await getUntrackedFileDiff(fx.ctx, 'big.txt', { maxLines: 100 });
    expect(diff.truncated).toBe(true);
    expect(diff.hunks[0]?.lines).toHaveLength(100);
  });

  it('改行コードが混在しても行がずれない', async () => {
    const CRLF = String.fromCharCode(13, 10);
    await fx.write('mixed.txt', 'a' + CRLF + 'b' + LF + 'c' + LF);
    await commitAll(fx, 'init');
    await fx.write('mixed.txt', 'a' + CRLF + 'B' + LF + 'c' + LF);

    const diff = await getFileDiff(fx.ctx, 'mixed.txt', false);
    const lines = diff?.hunks[0]?.lines ?? [];
    expect(lines.find((l) => l.kind === 'added')?.text).toBe('B');
    expect(lines.find((l) => l.kind === 'removed')?.text).toBe('b');
  });
});

describe('パッチ再構成のためのファイルヘッダ保存 (対応表 #33 / #34)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('通常の変更では diff --git と --- / +++ を生のまま持つ', async () => {
    await fx.write('a.txt', ['one', 'two'].join(LF) + LF);
    await commitAll(fx, 'init');
    await fx.write('a.txt', ['one', 'TWO'].join(LF) + LF);

    const diff = await getFileDiff(fx.ctx, 'a.txt', false);
    const pre = diff?.preamble ?? [];
    expect(pre[0]).toBe('diff --git a/a.txt b/a.txt');
    expect(pre.some((l) => l.startsWith('index '))).toBe(true);
    expect(pre).toContain('--- a/a.txt');
    expect(pre).toContain('+++ b/a.txt');
    // @@ 以降は含めない
    expect(pre.some((l) => l.startsWith('@@'))).toBe(false);
  });

  it('新規ファイルでは new file mode を持つ', async () => {
    await fx.write('a.txt', 'base' + LF);
    await commitAll(fx, 'init');
    await fx.write('新規 ファイル.txt', 'hello' + LF);
    await fx.run('add', '新規 ファイル.txt');

    const diff = await getFileDiff(fx.ctx, '新規 ファイル.txt', true);
    const pre = diff?.preamble ?? [];
    expect(pre.some((l) => l.startsWith('new file mode'))).toBe(true);
    // 空白入りの日本語パスもそのまま保存される（自前で組み立てない理由）
    expect(pre.some((l) => l.includes('新規 ファイル.txt'))).toBe(true);
  });

  it('リネームは単一パス指定では検出されず、全体追加として出る', async () => {
    await fx.write('old.txt', ['1', '2', '3', '4', '5'].join(LF) + LF);
    await commitAll(fx, 'init');
    await fx.run('mv', 'old.txt', 'new.txt');

    const diff = await getFileDiff(fx.ctx, 'new.txt', true);
    const pre = diff?.preamble ?? [];
    // `diff -- <新パス>` は元パスを見られないので rename を検出できない。
    // 結果として new file 扱いになり、hunk 単位の操作は「ファイル全体の追加」として拒否される
    expect(pre.some((l) => l.startsWith('new file mode'))).toBe(true);
    expect(pre).toContain('--- /dev/null');
    expect(pre.some((l) => l.startsWith('rename '))).toBe(false);
  });

  it('未追跡ファイルの合成 diff は preamble が空（git 由来でない印）', async () => {
    await fx.write('a.txt', 'base' + LF);
    await commitAll(fx, 'init');
    await fx.write('untracked.txt', ['x', 'y'].join(LF) + LF);

    const diff = await getUntrackedFileDiff(fx.ctx, 'untracked.txt');
    expect(diff?.preamble).toEqual([]);
    expect(diff?.hunks).toHaveLength(1);
  });
});
