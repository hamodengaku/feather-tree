import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildGeometry, buildRowPage, compareWorkbooks, openWorkbook, type Workbook } from '@feathertree/excel';
import { zlibInflater } from '../src/index.js';
import { buildXlsx } from '../../excel/test/xlsxBuilder.js';

/*
 * Excel 差分の性能（決定 33 / Phase 13 M1 の受け入れ条件。docs/01-architecture.md 12 章）。
 *
 * 通常の `npm test` では走らせない（数十秒かかる）。`npm run test:excel-perf [行数]` で明示実行する
 * （Unity の test:unity-perf と同じ作法）。本物の deflate（node:zlib）を通すため core に置く。
 *
 * 目標:
 *   - 3 万行 × 20 列（1 割の行を変更、いくつか挿入・削除）の両側を開いて比べる: 1.5 秒以内・ヒープ増分 400MB 以内
 *   - 5MB 級（展開後）の典型的なマスタ表: 300ms 以内
 *   - 256 行のページ: 10ms 以内
 */

const rows = Number.parseInt(process.env['FT_EXCEL_PERF_ROWS'] ?? '0', 10);
const COLS = 20;

/** ゲームのマスタ表に近い形（ID・名前・種別・数値の列）。行 i の内容は seed で決まる。 */
function cellsOf(i: number, variant: number): (string | number)[] {
  const out: (string | number)[] = [i + 1, 'item_' + String(i), ['sword', 'shield', 'bow', 'potion'][i % 4] ?? ''];
  for (let c = 3; c < COLS; c += 1) out.push(((i * 31 + c * 7) % 1000) + variant);
  return out;
}

function build(count: number, edit: boolean): Uint8Array {
  const table: (string | number)[][] = [Array.from({ length: COLS }, (_, c) => 'col' + String(c))];
  for (let i = 0; i < count; i += 1) {
    if (edit && i % 997 === 5) continue; // 削除
    table.push(cellsOf(i, edit && i % 10 === 0 ? 1 : 0)); // 1 割を変更
    if (edit && i % 1499 === 7) table.push(cellsOf(count + i, 0)); // 挿入
  }
  return buildXlsx({ sheets: [{ name: 'master', rows: table }] }, { deflate: (d) => deflateRawSync(d) });
}

function open(bytes: Uint8Array): Workbook {
  const r = openWorkbook(bytes, zlibInflater);
  if (!r.ok) throw new Error('open failed: ' + r.reason);
  return r.workbook;
}

function heapUsed(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed;
}

describe.runIf(rows > 0)('Excel 差分の性能', () => {
  it(`${String(rows)} 行 × ${String(COLS)} 列の両側を開いて比べる`, () => {
    const before = build(rows, false);
    const after = build(rows, true);

    const heap0 = heapUsed();
    const t0 = performance.now();
    const cmp = compareWorkbooks(open(before), open(after));
    const t1 = performance.now();
    const heapDelta = heapUsed() - heap0;

    const sheet = cmp.sheets[0];
    if (sheet === undefined) throw new Error('sheet');
    const t2 = performance.now();
    const geometry = buildGeometry(sheet);
    const t3 = performance.now();
    const middle = Math.floor(sheet.oldRow.length / 2);
    const page = buildRowPage(cmp, sheet, middle, 256, 2048);
    const t4 = performance.now();

    // 値は必ず出力に残す（Phase 13 の実測結果ログに記録するため）
    console.log(
      [
        'rows=' + String(rows),
        'xlsx=' + (after.length / 1024 / 1024).toFixed(2) + 'MB',
        'openAndCompareMs=' + (t1 - t0).toFixed(0),
        'heapDeltaMB=' + (heapDelta / 1024 / 1024).toFixed(1),
        'geometryMs=' + (t3 - t2).toFixed(1),
        'pageMs=' + (t4 - t3).toFixed(1),
        'changedRows=' + String(sheet.changedRowCount),
        'added=' + String(sheet.addedRows),
        'removed=' + String(sheet.removedRows),
        'positional=' + String(sheet.positional),
      ].join(' '),
    );

    expect(geometry.rowCount).toBe(sheet.oldRow.length);
    expect(page).toHaveLength(256);
    expect(sheet.positional).toBe(false);
    expect(t1 - t0).toBeLessThan(1500);
    expect(heapDelta).toBeLessThan(400 * 1024 * 1024);
    expect(t4 - t3).toBeLessThan(10);
  });

  it('5MB 級（展開後）の典型的なマスタ表は 300ms 以内', () => {
    // 1 行が約 100 バイトの XML になるので、5 万行で展開後 5MB 前後
    const count = 50_000 / 4;
    const before = build(count, false);
    const after = build(count, true);
    const t0 = performance.now();
    compareWorkbooks(open(before), open(after));
    const elapsed = performance.now() - t0;
    console.log('master rows=' + String(count) + ' openAndCompareMs=' + elapsed.toFixed(0));
    expect(elapsed).toBeLessThan(300);
  });
});
