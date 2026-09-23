// Unity の巨大シーンのパース性能を計測する（Phase 12 M1 の受け入れ条件）。
// FT_UNITY_PERF_MB を自プロセス内で設定するだけなので、システムの環境変数は変更しない。
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const megabytes = process.argv[2] ?? '50';

const result = spawnSync(
  process.execPath,
  [
    '--expose-gc',
    resolve(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    'packages/unity/test/performance.test.ts',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, FT_UNITY_PERF_MB: megabytes },
  },
);
process.exit(result.status ?? 1);
