// 巨大リポジトリの性能計測テストを実行する。
// FT_PERF_FILES を自プロセス内で設定するだけなので、システムの環境変数は変更しない。
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = process.argv[2] ?? '2000';

const result = spawnSync(
  process.execPath,
  [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', 'packages/git/test/performance.test.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, FT_PERF_FILES: files },
  },
);
process.exit(result.status ?? 1);
