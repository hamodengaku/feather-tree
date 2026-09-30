import { describe, expect, it } from 'vitest';
import { METHOD_DEFLATE, openZip, readZipEntry, sniffExcel, type Inflater } from '../src/index.js';
import { buildZip, identityInflater } from './zipBuilder.js';

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('ZIP の読み取り（決定 33）', () => {
  it('stored の要素をそのまま取り出す。名前は大文字小文字を区別しない', () => {
    const zip = buildZip([{ name: 'xl/Workbook.xml', data: '<workbook/>' }]);
    const opened = openZip(zip);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const entry = opened.archive.entries.get('xl/workbook.xml');
    expect(entry?.name).toBe('xl/Workbook.xml');
    if (entry === undefined) return;
    const read = readZipEntry(opened.archive, entry, identityInflater, 1000);
    expect(read.ok && text(read.data)).toBe('<workbook/>');
  });

  it('deflate は注入された inflater に上限つきで渡す', () => {
    const zip = buildZip([{ name: 'a.xml', data: 'hello', method: METHOD_DEFLATE }]);
    const opened = openZip(zip);
    if (!opened.ok) throw new Error('open');
    const seen: number[] = [];
    const spy: Inflater = (data, max) => {
      seen.push(max);
      return identityInflater(data, max);
    };
    const entry = opened.archive.entries.get('a.xml');
    if (entry === undefined) throw new Error('entry');
    const read = readZipEntry(opened.archive, entry, spy, 1234);
    expect(read.ok).toBe(true);
    expect(seen).toEqual([1234]);
  });

  it('宣言サイズが上限を超えていれば展開を始めない', () => {
    const zip = buildZip([{ name: 'a.xml', data: 'x', method: METHOD_DEFLATE, declaredSize: 10_000 }]);
    const opened = openZip(zip);
    if (!opened.ok) throw new Error('open');
    const entry = opened.archive.entries.get('a.xml');
    if (entry === undefined) throw new Error('entry');
    let called = false;
    const read = readZipEntry(opened.archive, entry, (d, m) => ((called = true), identityInflater(d, m)), 100);
    expect(read).toEqual({ ok: false, reason: 'too-large' });
    expect(called).toBe(false);
  });

  it('宣言を偽った ZIP 爆弾は inflater の上限で止まる', () => {
    const zip = buildZip([{ name: 'a.xml', data: 'x'.repeat(500), method: METHOD_DEFLATE, declaredSize: 10 }]);
    const opened = openZip(zip);
    if (!opened.ok) throw new Error('open');
    const entry = opened.archive.entries.get('a.xml');
    if (entry === undefined) throw new Error('entry');
    expect(readZipEntry(opened.archive, entry, identityInflater, 100)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('inflater が約束を破って投げても broken で止まる', () => {
    const zip = buildZip([{ name: 'a.xml', data: 'x', method: METHOD_DEFLATE }]);
    const opened = openZip(zip);
    if (!opened.ok) throw new Error('open');
    const entry = opened.archive.entries.get('a.xml');
    if (entry === undefined) throw new Error('entry');
    const read = readZipEntry(opened.archive, entry, () => {
      throw new Error('boom');
    }, 100);
    expect(read).toEqual({ ok: false, reason: 'broken' });
  });

  it('暗号化の印がある要素は読まない', () => {
    const zip = buildZip([{ name: 'a.xml', data: 'x', flags: 1 }]);
    const opened = openZip(zip);
    if (!opened.ok) throw new Error('open');
    const entry = opened.archive.entries.get('a.xml');
    if (entry === undefined) throw new Error('entry');
    expect(readZipEntry(opened.archive, entry, identityInflater, 100)).toEqual({ ok: false, reason: 'encrypted' });
  });

  it('ZIP64 の拡張欄のサイズと位置を読む', () => {
    const zip = buildZip([
      { name: 'first.xml', data: 'one' },
      { name: 'a.xml', data: 'hello', zip64: true },
    ]);
    const opened = openZip(zip);
    if (!opened.ok) throw new Error('open');
    const entry = opened.archive.entries.get('a.xml');
    expect(entry?.uncompressedSize).toBe(5);
    if (entry === undefined) return;
    const read = readZipEntry(opened.archive, entry, identityInflater, 100);
    expect(read.ok && text(read.data)).toBe('hello');
  });

  it('ZIP でないもの・切り詰めたものは例外を投げずに失敗を返す', () => {
    expect(openZip(new Uint8Array([1, 2, 3]))).toEqual({ ok: false, reason: 'not-zip' });
    const zip = buildZip([{ name: 'a.xml', data: 'hello' }]);
    // 目次の途中で切る（EOCD は残し、目次の位置を壊す）
    const broken = zip.slice();
    broken[broken.length - 6] = 0xff;
    expect(openZip(broken).ok).toBe(false);
    for (let cut = 1; cut < zip.length; cut += 7) {
      expect(() => openZip(zip.subarray(0, cut))).not.toThrow();
    }
  });
});

describe('形式の見分け', () => {
  it('ZIP / CFB / LFS ポインタ / 空 / 不明', () => {
    expect(sniffExcel(buildZip([]))).toBe('zip');
    expect(sniffExcel(buildZip([{ name: 'a', data: 'b' }]))).toBe('zip');
    expect(sniffExcel(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toBe('cfb');
    const pointer = new TextEncoder().encode(
      'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n',
    );
    expect(sniffExcel(pointer)).toBe('lfs-pointer');
    expect(sniffExcel(new Uint8Array(0))).toBe('empty');
    expect(sniffExcel(new TextEncoder().encode('hello'))).toBe('unknown');
  });
});
