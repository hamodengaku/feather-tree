import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildConflictFile,
  joinLines,
  parseConflictMarkers,
  readConflictFile,
  readConflictText,
  resolveConflictBlock,
  splitLines,
  writeConflictText,
} from '../src/index.js';
import { commitAll, createFixture, type Fixture } from './fixture.js';

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);

/**
 * 実際のマージで衝突を作る。
 *
 * マーカーの形（`<<<<<<< HEAD` 等）を手書きの文字列で決め打ちにしないため、
 * **git に書かせたファイル**で解析を検証する。ラベルや区切りの細部が git の版で
 * 変わったら、ここが落ちて気づける。
 */
async function makeConflict(
  fx: Fixture,
  base: string,
  ours: string,
  theirs: string,
  file = 'f.txt',
): Promise<void> {
  await fx.write(file, base);
  await commitAll(fx, 'base');
  await fx.run('switch', '-c', 'feature');
  await fx.write(file, theirs);
  await commitAll(fx, 'theirs');
  await fx.run('switch', 'main');
  await fx.write(file, ours);
  await commitAll(fx, 'ours');
  // 衝突するので exit != 0。ここでは失敗が期待値なので握り潰す
  await fx.run('merge', 'feature').catch(() => undefined);
}

const readBack = (fx: Fixture, file = 'f.txt'): Promise<string> =>
  readFile(join(fx.dir, file), 'utf8');

describe('コンフリクトマーカーの解析（git が書いたファイル）', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('衝突ブロックの位置・ラベル・各側の行数を返す', async () => {
    await makeConflict(
      fx,
      ['a', 'b', 'c', 'd', 'e'].join(LF) + LF,
      ['a', 'b', 'OURS', 'd', 'e'].join(LF) + LF,
      ['a', 'b', 'THEIRS', 'd', 'e'].join(LF) + LF,
    );

    const parsed = await readConflictText(fx.ctx, 'f.txt');
    expect(parsed).not.toBeNull();
    expect(parsed?.malformed).toBe(false);
    expect(parsed?.binary).toBe(false);
    expect(parsed?.blocks).toHaveLength(1);

    const block = parsed?.blocks[0];
    expect(block?.ourLabel).toBe('HEAD');
    expect(block?.theirLabel).toBe('feature');
    expect(block?.baseLine).toBeNull();
    expect(block?.ourCount).toBe(1);
    expect(block?.theirCount).toBe(1);

    // 行番号は 1 始まり。マーカー行そのものを指す
    const lines = parsed?.lines.map((l) => l.text) ?? [];
    expect(lines[(block?.startLine ?? 1) - 1]).toBe('<<<<<<< HEAD');
    expect(lines[(block?.separatorLine ?? 1) - 1]).toBe('=======');
    expect(lines[(block?.endLine ?? 1) - 1]).toBe('>>>>>>> feature');
  });

  it('diff3 スタイルでは共通祖先も取れる', async () => {
    await fx.run('config', 'merge.conflictStyle', 'diff3');
    await makeConflict(
      fx,
      ['a', 'BASE', 'c'].join(LF) + LF,
      ['a', 'OURS', 'c'].join(LF) + LF,
      ['a', 'THEIRS', 'c'].join(LF) + LF,
    );

    const parsed = await readConflictText(fx.ctx, 'f.txt');
    const block = parsed?.blocks[0];
    expect(block?.baseLine).not.toBeNull();
    expect(block?.baseCount).toBe(1);
    expect(block?.baseLabel).not.toBeNull();

    const baseText = parsed?.lines[(block?.baseLine ?? 1)]?.text;
    expect(baseText).toBe('BASE');
  });

  it('ours の採用でマーカーと theirs が消え、git から見ても素の内容になる', async () => {
    await makeConflict(
      fx,
      ['a', 'b', 'c'].join(LF) + LF,
      ['a', 'OURS', 'c'].join(LF) + LF,
      ['a', 'THEIRS', 'c'].join(LF) + LF,
    );

    const parsed = await readConflictText(fx.ctx, 'f.txt');
    const block = parsed?.blocks[0];
    expect(block).toBeDefined();
    if (parsed === null || block === undefined) return;

    await writeConflictText(fx.ctx, 'f.txt', resolveConflictBlock(parsed.lines, block, 'ours'));

    expect(await readBack(fx)).toBe(['a', 'OURS', 'c'].join(LF) + LF);
    // 解決後のファイルにマーカーは残らない
    const after = await readConflictFile(fx.ctx, 'f.txt');
    expect(after?.sections).toEqual([]);
  });

  it('複数の衝突のうち 1 件だけを採用しても、他の衝突は手つかずで残る', async () => {
    // 2 箇所を離す。近すぎると git が 1 つのブロックにまとめてしまう
    const fill = ['c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
    const build = (first: string, second: string): string =>
      ['a', first, ...fill, second, 'z'].join(LF) + LF;

    await makeConflict(fx, build('b', 'y'), build('O1', 'O2'), build('T1', 'T2'));

    const parsed = await readConflictText(fx.ctx, 'f.txt');
    expect(parsed?.blocks).toHaveLength(2);
    const second = parsed?.blocks[1];
    if (parsed === null || second === undefined) return;

    await writeConflictText(fx.ctx, 'f.txt', resolveConflictBlock(parsed.lines, second, 'theirs'));

    const after = await readConflictText(fx.ctx, 'f.txt');
    expect(after?.blocks).toHaveLength(1);
    // 残ったのは 1 件目（O1 / T1 の衝突）
    const lines = after?.lines.map((l) => l.text) ?? [];
    expect(lines).toContain('O1');
    expect(lines).toContain('T1');
    // 2 件目は theirs だけが残った
    expect(lines).toContain('T2');
    expect(lines).not.toContain('O2');
  });

  it('作業ツリーにファイルが無ければ null（削除との衝突）', async () => {
    await fx.write('f.txt', 'x' + LF);
    await commitAll(fx, 'init');
    expect(await readConflictText(fx.ctx, 'missing.txt')).toBeNull();
    expect(await readConflictFile(fx.ctx, 'missing.txt')).toBeNull();
  });

  it('バイナリは binary で返し、ブロックを作らない', async () => {
    await fx.write('bin.dat', 'ab' + String.fromCharCode(0) + 'cd');
    const file = await readConflictFile(fx.ctx, 'bin.dat');
    expect(file?.binary).toBe(true);
    expect(file?.sections).toEqual([]);
  });
});

describe('コンフリクトマーカーの解析（純関数）', () => {
  const marker = (n: number, ch: string): string => ch.repeat(n);

  it('ブロックの外にある ======= は本文として扱う（Markdown の見出し下線）', () => {
    const text = ['# 見出し', marker(7, '='), '本文'].join(LF) + LF;
    const parsed = parseConflictMarkers(text);
    expect(parsed.blocks).toEqual([]);
    expect(parsed.malformed).toBe(false);
  });

  it('閉じていないマーカーは malformed', () => {
    const text = [marker(7, '<') + ' HEAD', 'ours', 'まだ閉じていない'].join(LF) + LF;
    const parsed = parseConflictMarkers(text);
    expect(parsed.malformed).toBe(true);
    expect(parsed.blocks).toEqual([]);
  });

  it('入れ子のマーカーは malformed（どちらの側の本文か決められない）', () => {
    const text =
      [
        marker(7, '<') + ' HEAD',
        marker(7, '<') + ' 入れ子',
        marker(7, '='),
        'theirs',
        marker(7, '>') + ' feature',
      ].join(LF) + LF;
    expect(parseConflictMarkers(text).malformed).toBe(true);
  });

  it('8 文字以上の記号はマーカーと見なさない（長さは 7 固定）', () => {
    const text =
      [marker(8, '<'), 'ours', marker(7, '='), 'theirs', marker(7, '>')].join(LF) + LF;
    const parsed = parseConflictMarkers(text);
    expect(parsed.blocks).toEqual([]);
    expect(parsed.malformed).toBe(false);
  });

  it('CRLF は行ごとに保たれる（採用しても改行コードが置き換わらない）', () => {
    const text = [
      'a',
      marker(7, '<') + ' HEAD',
      'OURS',
      marker(7, '='),
      'THEIRS',
      marker(7, '>') + ' feature',
      'z',
    ].join(CRLF) + CRLF;

    const parsed = parseConflictMarkers(text);
    const block = parsed.blocks[0];
    expect(block).toBeDefined();
    if (block === undefined) return;

    const resolved = joinLines(resolveConflictBlock(parsed.lines, block, 'theirs'));
    expect(resolved).toBe(['a', 'THEIRS', 'z'].join(CRLF) + CRLF);
  });

  it('末尾に改行の無いファイルでは、採用しても改行が増えない', () => {
    const text = ['a', marker(7, '<') + ' HEAD', 'OURS', marker(7, '='), 'THEIRS', marker(7, '>') + ' f'].join(LF);
    const parsed = parseConflictMarkers(text);
    const block = parsed.blocks[0];
    expect(block).toBeDefined();
    if (block === undefined) return;

    expect(joinLines(resolveConflictBlock(parsed.lines, block, 'ours'))).toBe(['a', 'OURS'].join(LF));
  });

  it('両方を残す 2 つは、順序だけが違う', () => {
    const text =
      [marker(7, '<') + ' HEAD', 'O', marker(7, '='), 'T', marker(7, '>') + ' f'].join(LF) + LF;
    const parsed = parseConflictMarkers(text);
    const block = parsed.blocks[0];
    if (block === undefined) throw new Error('ブロックが取れていない');

    expect(joinLines(resolveConflictBlock(parsed.lines, block, 'ours-theirs'))).toBe(
      ['O', 'T'].join(LF) + LF,
    );
    expect(joinLines(resolveConflictBlock(parsed.lines, block, 'theirs-ours'))).toBe(
      ['T', 'O'].join(LF) + LF,
    );
  });

  it('片側が空の衝突（追加と削除の衝突）も採用できる', () => {
    const text =
      [marker(7, '<') + ' HEAD', marker(7, '='), 'T', marker(7, '>') + ' f', 'z'].join(LF) + LF;
    const parsed = parseConflictMarkers(text);
    const block = parsed.blocks[0];
    if (block === undefined) throw new Error('ブロックが取れていない');
    expect(block.ourCount).toBe(0);

    expect(joinLines(resolveConflictBlock(parsed.lines, block, 'ours'))).toBe('z' + LF);
  });

  it('splitLines は終端記号を行ごとに持ち、joinLines で元に戻る', () => {
    const text = 'a' + CRLF + 'b' + LF + 'c';
    expect(splitLines(text).map((l) => l.text)).toEqual(['a', 'b', 'c']);
    expect(joinLines(splitLines(text))).toBe(text);
  });
});

describe('コンフリクトの表示用の組み立て', () => {
  const marker = (n: number, ch: string): string => ch.repeat(n);
  const sample = (): string =>
    [
      'ctx1',
      'ctx2',
      'ctx3',
      'ctx4',
      marker(7, '<') + ' HEAD',
      'O',
      marker(7, '='),
      'T',
      marker(7, '>') + ' feature',
      'tail1',
      'tail2',
      'tail3',
      'tail4',
    ].join(LF) + LF;

  it('衝突の前後に文脈行を付け、行番号は作業ツリーのもの', () => {
    const file = buildConflictFile('f.txt', parseConflictMarkers(sample()), { contextLines: 2 });
    expect(file.sections).toHaveLength(1);

    const section = file.sections[0];
    expect(section?.startLine).toBe(5);
    expect(section?.endLine).toBe(9);

    const kinds = section?.lines.map((l) => `${String(l.lineNo)}:${l.kind}`) ?? [];
    expect(kinds).toEqual([
      '3:context',
      '4:context',
      '5:marker',
      '6:ours',
      '7:marker',
      '8:theirs',
      '9:marker',
      '10:context',
      '11:context',
    ]);
  });

  it('行数上限を超えたら truncated を立てて切る', () => {
    const file = buildConflictFile('f.txt', parseConflictMarkers(sample()), {
      contextLines: 2,
      maxLines: 4,
    });
    expect(file.truncated).toBe(true);
    expect(file.sections[0]?.truncated).toBe(true);
    expect(file.sections[0]?.lines).toHaveLength(4);
  });

  it('隣り合う衝突の文脈行は重複しない', () => {
    const text =
      [
        marker(7, '<') + ' HEAD',
        'O1',
        marker(7, '='),
        'T1',
        marker(7, '>') + ' f',
        'between',
        marker(7, '<') + ' HEAD',
        'O2',
        marker(7, '='),
        'T2',
        marker(7, '>') + ' f',
      ].join(LF) + LF;

    const file = buildConflictFile('f.txt', parseConflictMarkers(text), { contextLines: 3 });
    const shown = file.sections.flatMap((s) => s.lines.map((l) => l.lineNo));
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('マーカーが壊れていても、読めたところまでは表示に載せる', () => {
    const text =
      [
        marker(7, '<') + ' HEAD',
        'O1',
        marker(7, '='),
        'T1',
        marker(7, '>') + ' f',
        marker(7, '<') + ' HEAD',
        '閉じていない',
      ].join(LF) + LF;

    const parsed = parseConflictMarkers(text);
    expect(parsed.malformed).toBe(true);
    const file = buildConflictFile('f.txt', parsed, {});
    expect(file.malformed).toBe(true);
    expect(file.sections).toHaveLength(1);
  });
});
