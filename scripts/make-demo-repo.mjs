// 手動検証用の使い捨てリポジトリを .tmp/demo-repo に作る。
//
// ここで実行する git は「本リポジトリのソース管理」ではなく、
// 検証用フィクスチャの作成（CLAUDE.md 規約 1 の例外）。作成先は .tmp/ 配下に限定する。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '.tmp/demo-repo');

await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(join(repo, 'Assets/Untracked'), { recursive: true });

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} が失敗しました`);
};
const write = (rel, text) => writeFileSync(join(repo, rel), text, 'utf8');

git('init', '--initial-branch=main');
git('config', 'user.name', 'FeatherTree Demo');
git('config', 'user.email', 'demo@example.invalid');

write('README.md', 'v1\n');
write('Assets/config.json', '{ "value": 1 }\n');
git('add', '-A');
git('commit', '-m', '初回コミット');

git('branch', 'feature/日本語ブランチ');

// ステージ済み 1 件 / 未ステージ 1 件 / 未追跡 2 件 の状態を作る
write('README.md', 'v2 変更後\n');
git('add', 'README.md');
write('Assets/config.json', '{ "value": 2 }\n');
write('新規ファイル.txt', '未追跡のファイル\n');
write('Assets/Untracked/a.txt', 'x\n');

process.stdout.write(`デモリポジトリを作成しました:\n  ${repo}\n`);
process.stdout.write('  ステージ済み: README.md\n');
process.stdout.write('  未ステージ  : Assets/config.json\n');
process.stdout.write('  未追跡      : 新規ファイル.txt, Assets/Untracked/\n');
