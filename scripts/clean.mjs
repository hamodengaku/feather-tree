// ビルド出力を削除する。
//
// 【この環境の重要な制約】
// Node 24.12.0 / Windows 11 26200 のこの環境では、同期版の `rmSync` を呼ぶと
// プロセスが即死する（終了コード 127、stdout/stderr も失われる）。
// recursive の有無に関係なく再現する。非同期の `rm` は正常に動作するため、
// このリポジトリでは **rmSync を使わない**（CLAUDE.md の環境の癖を参照）。
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const targets = process.argv.slice(2);
const dirs = targets.length > 0 ? targets : ['out'];

for (const dir of dirs) {
  await rm(resolve(root, dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.stdout.write(`[clean] ${dir}\n`);
}
