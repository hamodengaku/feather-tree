import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getStatus } from '../src/index.js';
import { commitAll, createFixture, type Fixture } from './fixture.js';

/**
 * Phase 1 DoD の必須項目: 合成 1 万ファイルでのパース時間を計測し、数値を出力に残す。
 * 閾値は「明らかな退行の検出」用に緩く取る。厳密な目標は Phase 10 で実機計測する。
 */
/**
 * 既定は 2,000 件。Windows ではファイル生成と git add がウイルス対策の影響で非常に遅く、
 * 10,000 件の前準備だけで 5 分を超えることがある（パーサではなく前準備が支配的）。
 * 10,000 件で測りたいときは FT_PERF_FILES=10000 を指定する。
 */
const FILE_COUNT = Number.parseInt(process.env['FT_PERF_FILES'] ?? '2000', 10);
const DIR_COUNT = Math.max(10, Math.floor(FILE_COUNT / 100));

// 前準備（git add + commit）がこの環境では 2,000 件で 200 秒以上かかるため、
// 通常の npm test では走らせない。npm run test:perf で明示的に実行する。
describe.runIf(process.env['FT_PERF_FILES'] !== undefined)('巨大リポジトリでの status', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it(`${String(FILE_COUNT)} ファイルの status を扱える`, async () => {
    // Unity プロジェクトを模して階層に分散させる
    const perDir = FILE_COUNT / DIR_COUNT;
    for (let d = 0; d < DIR_COUNT; d += 1) {
      const dir = join(fx.dir, 'Assets', `Group${String(d).padStart(3, '0')}`);
      await mkdir(dir, { recursive: true });
      const writes: Promise<void>[] = [];
      for (let i = 0; i < perDir; i += 1) {
        writes.push(writeFile(join(dir, `asset_${String(i).padStart(4, '0')}.txt`), `v0-${String(d)}-${String(i)}`, 'utf8'));
      }
      await Promise.all(writes);
    }

    const commitStart = Date.now();
    await commitAll(fx, 'bulk import');
    const commitMs = Date.now() - commitStart;

    // クリーンな状態
    const cleanStart = Date.now();
    const clean = await getStatus(fx.ctx);
    const cleanMs = Date.now() - cleanStart;
    expect(clean.entries).toHaveLength(0);

    // 1000 件を変更した状態
    const changeWrites: Promise<void>[] = [];
    for (let d = 0; d < Math.max(1, Math.floor(DIR_COUNT / 10)); d += 1) {
      const dir = join(fx.dir, 'Assets', `Group${String(d).padStart(3, '0')}`);
      for (let i = 0; i < perDir; i += 1) {
        changeWrites.push(writeFile(join(dir, `asset_${String(i).padStart(4, '0')}.txt`), `v1-${String(d)}-${String(i)}`, 'utf8'));
      }
    }
    await Promise.all(changeWrites);

    const dirtyStart = Date.now();
    const dirty = await getStatus(fx.ctx);
    const dirtyMs = Date.now() - dirtyStart;

    expect(dirty.entries).toHaveLength(Math.max(1, Math.floor(DIR_COUNT / 10)) * perDir);
    expect(dirty.counts.unstaged).toBe(Math.max(1, Math.floor(DIR_COUNT / 10)) * perDir);
    expect(dirty.entries.every((e) => e.kind === 'ordinary')).toBe(true);

    // 全ファイルが未追跡の状態（最悪ケース）
    const untrackedFx = await createFixture();
    try {
      const bulk: Promise<void>[] = [];
      for (let d = 0; d < DIR_COUNT; d += 1) {
        const dir = join(untrackedFx.dir, 'Assets', `G${String(d)}`);
        await mkdir(dir, { recursive: true });
        for (let i = 0; i < perDir; i += 1) {
          bulk.push(writeFile(join(dir, `a${String(i)}.txt`), 'x', 'utf8'));
        }
      }
      await Promise.all(bulk);

      const allStart = Date.now();
      const all = await getStatus(untrackedFx.ctx, { untrackedFiles: 'all' });
      const allMs = Date.now() - allStart;
      expect(all.entries).toHaveLength(FILE_COUNT);

      process.stdout.write(
        [
          '',
          `  [計測] status の所要時間（git 実行 + パース、${String(FILE_COUNT)} ファイル）`,
          `    一括コミット           : ${String(commitMs)} ms（前準備）`,
          `    変更なし               : ${String(cleanMs)} ms`,
          `    1 割を変更             : ${String(dirtyMs)} ms`,
          `    全件が未追跡           : ${String(allMs)} ms (--untracked-files=all)`,
          '',
        ].join('\n'),
      );

      expect(cleanMs).toBeLessThan(10_000);
      expect(dirtyMs).toBeLessThan(15_000);
      expect(allMs).toBeLessThan(20_000);
    } finally {
      await untrackedFx.cleanup();
    }
  }, 900_000);
});
