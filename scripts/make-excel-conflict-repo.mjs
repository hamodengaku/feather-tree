// 手動検証用: Excel のブックがコンフリクトした状態のリポジトリを .tmp/excel-conflict-repo に作る
// （決定 34 / docs/07-xlsx-cell-merge.md 8 章。Excel 本体で開いて確かめるのは人間）。
//
// 使い方:
//   node scripts/make-excel-conflict-repo.mjs <共通祖先.xlsx> <自分側.xlsx> <相手側.xlsx>
//
// 3 つのブックは Excel で作っておく（共通祖先を複製して、自分側・相手側をそれぞれ編集したもの）。
// 共通祖先をコミット → topic ブランチで相手側をコミット → main で自分側をコミット → main へ topic をマージ、
// の順に進めるので、最後のマージで衝突した状態になる。FeatherTree でこのフォルダを開き、Excel モードで解消する。
//
// ここで実行する git は「本リポジトリのソース管理」ではなく、検証用フィクスチャの作成
// （CLAUDE.md 規約 1 の例外）。作成先は .tmp/ 配下に限定する。
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const LF = String.fromCharCode(10);
const [baseArg, oursArg, theirsArg] = process.argv.slice(2);
if (baseArg === undefined || oursArg === undefined || theirsArg === undefined) {
  process.stderr.write('使い方: node scripts/make-excel-conflict-repo.mjs <共通祖先.xlsx> <自分側.xlsx> <相手側.xlsx>' + LF);
  process.exit(1);
}
const inputs = [baseArg, oursArg, theirsArg].map((p) => resolve(p));
for (const p of inputs) {
  if (!existsSync(p)) {
    process.stderr.write(`ファイルがありません: ${p}${LF}`);
    process.exit(1);
  }
}
const [base, ours, theirs] = inputs;

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '.tmp/excel-conflict-repo');
await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(repo, { recursive: true });

const git = (...args) => spawnSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true }).status;
const must = (...args) => {
  if (git(...args) !== 0) throw new Error(`git ${args.join(' ')} が失敗しました`);
};

// 名前は共通祖先のファイル名に揃える（拡張子は .xlsx / .xlsm をそのまま使う）
const name = basename(base, extname(base)) + extname(base);
const put = (src) => copyFileSync(src, join(repo, name));

must('init', '--initial-branch=main');
must('config', 'user.name', 'FeatherTree Demo');
must('config', 'user.email', 'demo@example.invalid');
must('config', 'core.autocrlf', 'false');

put(base);
must('add', '-A');
must('commit', '-m', '共通祖先');

must('switch', '-c', 'topic');
put(theirs);
must('commit', '-am', '相手側の編集');

must('switch', 'main');
put(ours);
must('commit', '-am', '自分側の編集');

// 衝突するので失敗するのが正しい
const merged = git('merge', 'topic');
process.stdout.write(
  (merged === 0
    ? '注意: マージが衝突せずに終わりました（3 つのブックの中身を確かめてください）。'
    : 'ブックがコンフリクトした状態のリポジトリを作成しました。') +
    LF +
    `  ${repo}${LF}` +
    `  ファイル: ${name}${LF}`,
);
