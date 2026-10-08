import { describe, expect, it } from 'vitest';
import { composeCsv, csvRecordSpans, csvRecords, splitCsvConflict, type CsvRowPlan } from '../src/index.js';

/*
 * CSV のコンフリクト（決定 34）。マーカーの分解と、行・欄の継ぎ合わせ。
 * バイト列のまま扱うので、Shift_JIS の 2 バイト文字も壊さないことを確かめる。
 */

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function split(text: string): { ours: string; theirs: string; blocks: number } {
  const r = splitCsvConflict(encode(text));
  if (r.kind !== 'split') throw new Error('not split: ' + r.kind);
  return { ours: decode(r.ours), theirs: decode(r.theirs), blocks: r.blocks };
}

describe('splitCsvConflict', () => {
  it('マーカーの外は両側に、中は各側に入る', () => {
    const r = split('h,v\na,1\n<<<<<<< HEAD\nb,M\n=======\nb,T\nc,T\n>>>>>>> topic\nd,4\n');
    expect(r.blocks).toBe(1);
    expect(r.ours).toBe('h,v\na,1\nb,M\nd,4\n');
    expect(r.theirs).toBe('h,v\na,1\nb,T\nc,T\nd,4\n');
  });

  it('diff3 の共通祖先はどちらにも入れない・CRLF を保つ', () => {
    const r = split('<<<<<<< HEAD\r\nx,M\r\n||||||| base\r\nx,B\r\n=======\r\nx,T\r\n>>>>>>> topic\r\n');
    expect(r.ours).toBe('x,M\r\n');
    expect(r.theirs).toBe('x,T\r\n');
  });

  it('>>>>>>> で改行なしに終わるファイルは、組んだ結果も改行なしで終わる', () => {
    const r = split('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> t');
    expect(r.ours).toBe('a\nb');
    expect(r.theirs).toBe('a\nc');
  });

  it('マーカーが無い・壊れている・UTF-16 を見分ける', () => {
    expect(splitCsvConflict(encode('a,1\n')).kind).toBe('none');
    expect(splitCsvConflict(encode('<<<<<<< HEAD\na\n')).kind).toBe('malformed');
    expect(splitCsvConflict(encode('<<<<<<< HEAD\n<<<<<<< x\n=======\n>>>>>>> t\n')).kind).toBe('malformed');
    expect(splitCsvConflict(Uint8Array.of(0xff, 0xfe, 0x61, 0x00)).kind).toBe('unsupported');
    // 8 文字目も同じ記号なら本文
    expect(splitCsvConflict(encode('<<<<<<<< x\n')).kind).toBe('none');
  });
});

describe('csvRecordSpans', () => {
  it('レコードの区切りが csvRecords と一致する（引用符の中の改行・カンマ・""）', () => {
    const text = 'a,"b,c",d\r\n"x\ny","q""q"\n\nlast,"open';
    const bytes = encode(text);
    const spans = csvRecordSpans(bytes);
    const records = [...csvRecords(text)];
    expect(spans.records.length).toBe(records.length);
    spans.records.forEach((r, i) => expect(r.fields.length).toBe(records[i]?.length));
    expect(decode(bytes.subarray(...(spans.records[0]?.fields[1] ?? [0, 0])))).toBe('"b,c"');
  });

  it('UTF-8 の BOM を飛ばす', () => {
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, ...encode('a,b\n'));
    const spans = csvRecordSpans(bytes);
    expect(spans.bom).toBe(3);
    expect(spans.records[0]?.fields[0]).toEqual([3, 4]);
  });
});

describe('composeCsv', () => {
  const ours = encode('h,v\nb,M,1\n"q,1",x\n');
  const theirs = encode('h,v\nb,T,2\nnew,row\n"q,1",y\n');

  it('丸ごと片側の行は元のバイトのまま、混ざる行は欄を継ぎ合わせる', () => {
    const plans: CsvRowPlan[] = [
      { kind: 'ours', row: 0 },
      { kind: 'mixed', oursRow: 1, theirsRow: 1, theirsCols: new Set([2]) },
      { kind: 'theirs', row: 2 },
      { kind: 'mixed', oursRow: 2, theirsRow: 3, theirsCols: new Set([1]) },
    ];
    expect(decode(composeCsv(ours, theirs, plans))).toBe('h,v\nb,M,2\nnew,row\n"q,1",y\n');
  });

  it('欄の数が違えば多いほうに合わせる（足りない側の欄は空）', () => {
    const plans: CsvRowPlan[] = [{ kind: 'mixed', oursRow: 0, theirsRow: 1, theirsCols: new Set([2]) }];
    expect(decode(composeCsv(ours, theirs, plans))).toBe('h,v,2\n');
  });

  it('末尾の改行の有無は自分側に合わせ、途中に来た改行なしのレコードには改行を補う', () => {
    const o = encode('a\r\nb');
    const t = encode('c');
    const plans: CsvRowPlan[] = [
      { kind: 'theirs', row: 0 },
      { kind: 'ours', row: 0 },
      { kind: 'ours', row: 1 },
    ];
    expect(decode(composeCsv(o, t, plans))).toBe('c\r\na\r\nb');
  });

  it('Shift_JIS の 2 バイト文字を壊さない（2 バイト目が 0x5c・0x7c でも）', () => {
    // 「表」= 0x95 0x5c、「怖」= 0x95 0x7c
    const o = Uint8Array.of(0x95, 0x5c, 0x2c, 0x31, 0x0a);
    const t = Uint8Array.of(0x95, 0x7c, 0x2c, 0x32, 0x0a);
    const out = composeCsv(o, t, [{ kind: 'mixed', oursRow: 0, theirsRow: 0, theirsCols: new Set([1]) }]);
    expect(Array.from(out)).toEqual([0x95, 0x5c, 0x2c, 0x32, 0x0a]);
  });

  it('BOM は自分側のものを先頭に付ける', () => {
    const o = Uint8Array.of(0xef, 0xbb, 0xbf, ...encode('a\n'));
    const t = Uint8Array.of(0xef, 0xbb, 0xbf, ...encode('b\n'));
    expect(Array.from(composeCsv(o, t, [{ kind: 'theirs', row: 0 }]))).toEqual([0xef, 0xbb, 0xbf, 0x62, 0x0a]);
  });
});
