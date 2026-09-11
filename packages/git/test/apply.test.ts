import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyHunks, getFileDiff, GitCommandError } from '../src/index.js';
import { commitAll, createFixture, type Fixture } from './fixture.js';

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);

describe('hunk / 行の適用 (対応表 #33 / #34)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  /** 3 か所離れた変更を作る（hunk が 3 つに割れる程度の間隔を空ける）。 */
  async function threeHunks(): Promise<void> {
    const base = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    await fx.write('a.txt', base.join(LF) + LF);
    await commitAll(fx, 'init');

    const edited = [...base];
    edited[1] = 'CHANGED-A';
    edited[14] = 'CHANGED-B';
    edited[27] = 'CHANGED-C';
    await fx.write('a.txt', edited.join(LF) + LF);
  }

  it('hunk 1 つだけをステージし、残りは未ステージのまま残す', async () => {
    await threeHunks();
    const diff = await getFileDiff(fx.ctx, 'a.txt', false);
    expect(diff?.hunks).toHaveLength(3);

    const changed = await applyHunks(fx.ctx, diff!, [{ index: 1, lines: null }], 'stage');
    expect(changed).toBe(2); // -line15 / +CHANGED-B

    const staged = await getFileDiff(fx.ctx, 'a.txt', true);
    expect(staged?.hunks).toHaveLength(1);
    expect(staged?.hunks[0]?.lines.some((l) => l.text === 'CHANGED-B')).toBe(true);

    const rest = await getFileDiff(fx.ctx, 'a.txt', false);
    expect(rest?.hunks).toHaveLength(2);
  });

  it('複数の hunk を 1 回の apply でまとめてステージできる', async () => {
    await threeHunks();
    const diff = await getFileDiff(fx.ctx, 'a.txt', false);

    await applyHunks(
      fx.ctx,
      diff!,
      [
        { index: 0, lines: null },
        { index: 2, lines: null },
      ],
      'stage',
    );

    const staged = await getFileDiff(fx.ctx, 'a.txt', true);
    const stagedText = (staged?.hunks ?? []).flatMap((h) => h.lines.map((l) => l.text));
    expect(stagedText).toContain('CHANGED-A');
    expect(stagedText).toContain('CHANGED-C');
    expect(stagedText).not.toContain('CHANGED-B');
  });

  it('作業ツリーには一切触れない（--cached の証明）', async () => {
    await threeHunks();
    const before = await readFile(join(fx.dir, 'a.txt'), 'utf8');
    const diff = await getFileDiff(fx.ctx, 'a.txt', false);

    await applyHunks(fx.ctx, diff!, [{ index: 0, lines: null }], 'stage');

    expect(await readFile(join(fx.dir, 'a.txt'), 'utf8')).toBe(before);
  });

  it('1 つの hunk のうち 1 行だけをステージできる', async () => {
    const base = ['a', 'b', 'c'];
    await fx.write('a.txt', base.join(LF) + LF);
    await commitAll(fx, 'init');
    // 隣接する 3 行をまとめて書き換える → 1 hunk に 3 対の変更が入る
    await fx.write('a.txt', ['A', 'B', 'C'].join(LF) + LF);

    const diff = await getFileDiff(fx.ctx, 'a.txt', false);
    expect(diff?.hunks).toHaveLength(1);
    const lines = diff?.hunks[0]?.lines ?? [];
    const bIndex = lines.findIndex((l) => l.kind === 'added' && l.text === 'B');
    expect(bIndex).toBeGreaterThanOrEqual(0);

    // 「b を B にする」だけをステージする（-b と +B の 2 行）
    const removedB = lines.findIndex((l) => l.kind === 'removed' && l.text === 'b');
    await applyHunks(fx.ctx, diff!, [{ index: 0, lines: [removedB, bIndex] }], 'stage');

    const staged = await getFileDiff(fx.ctx, 'a.txt', true);
    const stagedTexts = (staged?.hunks ?? []).flatMap((h) =>
      h.lines.filter((l) => l.kind !== 'context').map((l) => l.text),
    );
    expect(stagedTexts).toEqual(['b', 'B']);

    // index の中身は a / B / c になっている
    const blob = await fx.run('show', ':a.txt');
    expect(blob.split(LF).slice(0, 3)).toEqual(['a', 'B', 'c']);
  });

  it('ステージ済みの hunk を 1 つだけアンステージできる（--reverse）', async () => {
    await threeHunks();
    await fx.run('add', 'a.txt');

    const staged = await getFileDiff(fx.ctx, 'a.txt', true);
    expect(staged?.hunks).toHaveLength(3);

    await applyHunks(fx.ctx, staged!, [{ index: 1, lines: null }], 'unstage');

    const stillStaged = await getFileDiff(fx.ctx, 'a.txt', true);
    expect(stillStaged?.hunks).toHaveLength(2);
    const texts = (stillStaged?.hunks ?? []).flatMap((h) => h.lines.map((l) => l.text));
    expect(texts).not.toContain('CHANGED-B');

    // HEAD からの差分（作業ツリー全体）は変わらない = 戻しただけで内容は失われていない
    const worktree = await readFile(join(fx.dir, 'a.txt'), 'utf8');
    expect(worktree).toContain('CHANGED-B');
  });

  it('アンステージでも行単位で戻せる', async () => {
    await fx.write('a.txt', ['a', 'b', 'c'].join(LF) + LF);
    await commitAll(fx, 'init');
    await fx.write('a.txt', ['A', 'B', 'C'].join(LF) + LF);
    await fx.run('add', 'a.txt');

    const staged = await getFileDiff(fx.ctx, 'a.txt', true);
    const lines = staged?.hunks[0]?.lines ?? [];
    const removedB = lines.findIndex((l) => l.kind === 'removed' && l.text === 'b');
    const addedB = lines.findIndex((l) => l.kind === 'added' && l.text === 'B');

    await applyHunks(fx.ctx, staged!, [{ index: 0, lines: [removedB, addedB] }], 'unstage');

    // index は A / b / C（B だけが HEAD の状態に戻る）
    const blob = await fx.run('show', ':a.txt');
    expect(blob.split(LF).slice(0, 3)).toEqual(['A', 'b', 'C']);
  });

  it('日本語と空白を含むパスでも適用できる', async () => {
    const name = '日本語 ファイル.txt';
    await fx.write(name, ['あ', 'い', 'う'].join(LF) + LF);
    await commitAll(fx, 'init');
    await fx.write(name, ['あ', 'イ', 'う'].join(LF) + LF);

    const diff = await getFileDiff(fx.ctx, name, false);
    await applyHunks(fx.ctx, diff!, [{ index: 0, lines: null }], 'stage');

    const staged = await getFileDiff(fx.ctx, name, true);
    expect(staged?.hunks[0]?.lines.some((l) => l.text === 'イ')).toBe(true);
  });

  it('CRLF ファイルでも改行が壊れない', async () => {
    // fixture は core.autocrlf=false なので、書いた通りのバイトが index に入る
    await fx.write('crlf.txt', ['one', 'two', 'three'].join(CRLF) + CRLF);
    await commitAll(fx, 'init');
    await fx.write('crlf.txt', ['one', 'TWO', 'three'].join(CRLF) + CRLF);

    const diff = await getFileDiff(fx.ctx, 'crlf.txt', false);
    await applyHunks(fx.ctx, diff!, [{ index: 0, lines: null }], 'stage');

    const blob = await fx.run('show', ':crlf.txt');
    expect(blob).toContain('TWO' + CRLF);
    // 未ステージ側に差分が残っていない = index と作業ツリーが一致した
    const rest = await getFileDiff(fx.ctx, 'crlf.txt', false);
    expect(rest?.hunks ?? []).toHaveLength(0);
  });

  it('末尾に改行がないファイルでも hunk 全体なら適用できる', async () => {
    await fx.write('nonl.txt', ['one', 'two'].join(LF));
    await commitAll(fx, 'init');
    await fx.write('nonl.txt', ['one', 'TWO'].join(LF));

    const diff = await getFileDiff(fx.ctx, 'nonl.txt', false);
    expect(diff?.hunks[0]?.lines.some((l) => l.kind === 'no-newline')).toBe(true);

    await applyHunks(fx.ctx, diff!, [{ index: 0, lines: null }], 'stage');

    const blob = await fx.run('show', ':nonl.txt');
    expect(blob).toBe(['one', 'TWO'].join(LF));
  });

  it('文脈行 0 の diff は --unidiff-zero を付けて適用する', async () => {
    await fx.write('a.txt', ['a', 'b', 'c'].join(LF) + LF);
    await commitAll(fx, 'init');
    await fx.write('a.txt', ['a', 'B', 'c'].join(LF) + LF);

    const diff = await getFileDiff(fx.ctx, 'a.txt', false, { contextLines: 0 });
    expect(diff?.hunks[0]?.lines.every((l) => l.kind !== 'context')).toBe(true);

    await applyHunks(fx.ctx, diff!, [{ index: 0, lines: null }], 'stage', { contextLines: 0 });

    const blob = await fx.run('show', ':a.txt');
    expect(blob.split(LF).slice(0, 3)).toEqual(['a', 'B', 'c']);
  });

  it('適用できないパッチでは index が一切変わらない（apply の原子性）', async () => {
    await threeHunks();
    const diff = await getFileDiff(fx.ctx, 'a.txt', false);

    // diff を取ったあとで index を別の内容に差し替える（--cached は index に当たる）
    await fx.write('a.txt', ['まったく', '別の', '内容'].join(LF) + LF);
    await fx.run('add', 'a.txt');
    const indexBefore = await fx.run('rev-parse', ':a.txt');

    await expect(
      applyHunks(fx.ctx, diff!, [{ index: 0, lines: null }], 'stage'),
    ).rejects.toBeInstanceOf(GitCommandError);

    expect(await fx.run('rev-parse', ':a.txt')).toBe(indexBefore);
  });

  it('一時パッチファイルを残さない', async () => {
    await threeHunks();
    const diff = await getFileDiff(fx.ctx, 'a.txt', false);

    await applyHunks(fx.ctx, diff!, [{ index: 0, lines: null }], 'stage');

    const left = await readdir(fx.ctx.tempDir).catch(() => [] as string[]);
    expect(left.filter((f) => f.startsWith('patch-'))).toEqual([]);
  });
});
