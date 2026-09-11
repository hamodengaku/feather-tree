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

const LF = String.fromCharCode(10);

/** hunk 単位の操作を試せるよう、離れた 3 か所を書き換えられる長めのファイルを作る。 */
const lines = (n) => Array.from({ length: n }, (_, i) => `行 ${String(i + 1)}`);

write('README.md', 'v1' + LF);
write('Assets/config.json', '{ "value": 1 }' + LF);
write('hunks.txt', lines(30).join(LF) + LF);
git('add', '-A');
git('commit', '-m', '初回コミット');

git('branch', 'feature/日本語ブランチ');

// マージを試すためのブランチ。main から分岐して 1 コミット進めておく
git('switch', '-c', 'topic/マージ元');
write('topic.txt', 'マージで取り込まれるファイル' + LF);
git('add', '-A');
git('commit', '-m', 'マージ用のコミット');
git('switch', 'main');

// ステージ済み 1 件 / 未ステージ 1 件 / 未追跡 2 件 の状態を作る
write('README.md', 'v2 変更後' + LF);
git('add', 'README.md');
write('Assets/config.json', '{ "value": 2 }' + LF);
write('新規ファイル.txt', '未追跡のファイル' + LF);
write('Assets/Untracked/a.txt', 'x' + LF);

// 3 hunk に割れる変更（hunk / 行単位のステージを手で試すため）
const edited = lines(30);
edited[1] = '行 2 を書き換え';
edited[14] = '行 15 を書き換え';
edited[27] = '行 28 を書き換え';
write('hunks.txt', edited.join(LF) + LF);

process.stdout.write(`デモリポジトリを作成しました:${LF}  ${repo}${LF}`);
process.stdout.write('  ステージ済み: README.md' + LF);
process.stdout.write('  未ステージ  : Assets/config.json, hunks.txt（3 hunk）' + LF);
process.stdout.write('  未追跡      : 新規ファイル.txt, Assets/Untracked/' + LF);
process.stdout.write('  マージ試験用: topic/マージ元 を右クリック → マージ' + LF);
