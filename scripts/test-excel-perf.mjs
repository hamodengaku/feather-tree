// Excel 差分の性能を計測する（Phase 13 M1 の受け入れ条件。決定 33）。
// FT_EXCEL_PERF_ROWS を自プロセス内で設定するだけなので、システムの環境変数は変更しない。
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const rows = process.argv[2] ?? '30000';

const result = spawnSync(
  process.execPath,
  [
    '--expose-gc',
    resolve(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    'packages/core/test/excelPerformance.test.ts',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, FT_EXCEL_PERF_ROWS: rows },
  },
);
process.exit(result.status ?? 1);
