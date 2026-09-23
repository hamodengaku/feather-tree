import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildScriptIndex, extractGuid } from '../src/index.js';

/*
 * guid -> スクリプト名 / Prefab 名の索引（Phase 12 M7 / 要件 11）。
 *
 * **git は 1 プロセスも起動しない。** Node のファイル走査だけで、
 * 利用者がボタンを押したときにしか走らない。
 */

const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/core-script-index-tests');
const LF = String.fromCharCode(10);

function meta(guid: string): string {
  return ['fileFormatVersion: 2', 'guid: ' + guid, 'MonoImporter:', '  externalObjects: {}', ''].join(
    LF,
  );
}

describe('guid の取り出し', () => {
  it('2 行目の guid を読む', () => {
    expect(extractGuid(meta('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'))).toBe(
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    );
  });

  it('大文字は小文字に揃える（Prefab 側は小文字で書かれる）', () => {
    expect(extractGuid('guid: A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6')).toBe(
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    );
  });

  it('32 桁でなければ採らない', () => {
    expect(extractGuid('guid: abc')).toBeNull();
  });

  it('16 進でなければ採らない', () => {
    expect(extractGuid('guid: zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBeNull();
  });

  it('guid が無ければ null', () => {
    expect(extractGuid('fileFormatVersion: 2')).toBeNull();
  });
});

describe('リポジトリの走査', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      () => undefined,
    );
  });

  async function write(rel: string, content: string): Promise<void> {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  it('.cs.meta は拡張子を落として型名にする（要件 11）', async () => {
    await write('Assets/Scripts/WeaponController.cs.meta', meta('11111111111111111111111111111111'));
    const index = await buildScriptIndex(dir);
    expect(index.names.get('11111111111111111111111111111111')).toBe('WeaponController');
  });

  it('.prefab.meta は拡張子を残す（「どの Prefab か」が読めるように）', async () => {
    await write('Assets/Prefabs/Actor.prefab.meta', meta('22222222222222222222222222222222'));
    const index = await buildScriptIndex(dir);
    expect(index.names.get('22222222222222222222222222222222')).toBe('Actor.prefab');
  });

  it('入れ子のフォルダもたどる', async () => {
    await write('Assets/A/B/C/Deep.cs.meta', meta('33333333333333333333333333333333'));
    const index = await buildScriptIndex(dir);
    expect(index.names.get('33333333333333333333333333333333')).toBe('Deep');
  });

  it('Unity の生成物は読まない（Library / Temp / obj など）', async () => {
    await write('Library/Copy.cs.meta', meta('44444444444444444444444444444444'));
    await write('Temp/Copy.cs.meta', meta('55555555555555555555555555555555'));
    await write('obj/Copy.cs.meta', meta('66666666666666666666666666666666'));
    await write('.git/Copy.cs.meta', meta('77777777777777777777777777777777'));
    const index = await buildScriptIndex(dir);
    expect(index.names.size).toBe(0);
    expect(index.scanned).toBe(0);
  });

  it('対象外の .meta は読まない（.png.meta など）', async () => {
    await write('Assets/Art/icon.png.meta', meta('88888888888888888888888888888888'));
    await write('Assets/Scripts/Keep.cs.meta', meta('99999999999999999999999999999999'));
    const index = await buildScriptIndex(dir);
    expect(index.names.size).toBe(1);
    expect(index.names.get('99999999999999999999999999999999')).toBe('Keep');
  });

  it('guid を持たない .meta は飛ばす（壊れていても止まらない）', async () => {
    await write('Assets/Broken.cs.meta', 'fileFormatVersion: 2' + LF);
    await write('Assets/Good.cs.meta', meta('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    const index = await buildScriptIndex(dir);
    expect(index.names.size).toBe(1);
    expect(index.scanned).toBe(1);
  });

  it('読んだ件数を返す（画面に出すため）', async () => {
    await write('Assets/One.cs.meta', meta('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));
    await write('Assets/Two.cs.meta', meta('cccccccccccccccccccccccccccccccc'));
    expect((await buildScriptIndex(dir)).scanned).toBe(2);
  });

  it('空のリポジトリでも落ちない', async () => {
    const index = await buildScriptIndex(dir);
    expect(index.names.size).toBe(0);
  });

  it('中断されたら例外で抜ける（走査の途中で捨てられる）', async () => {
    await write('Assets/One.cs.meta', meta('dddddddddddddddddddddddddddddddd'));
    const controller = new AbortController();
    controller.abort();
    await expect(buildScriptIndex(dir, controller.signal)).rejects.toThrow();
  });
});
