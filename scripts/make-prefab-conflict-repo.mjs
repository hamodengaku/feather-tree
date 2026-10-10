// 手動検証用: Prefab がコンフリクトした状態のリポジトリを .tmp/prefab-conflict-repo に作る
// （Unity モードの GameObject 単位の解消。2026-10-10）。
//
// 使い方:
//   node scripts/make-prefab-conflict-repo.mjs
//
// 中身は小さな UI の Prefab（Canvas ＞ Panel ＞ Button）。次の 3 種類の違いが入る:
//   - Canvas の名前を両側が変えた           … 衝突（ours / theirs を選ぶ）
//   - Panel の RectTransform を相手側だけ変えた … 自動で相手側
//   - Button の下に相手側だけ Label を足した   … 自動で相手側（Panel を自分側にしても子は付く）
// FeatherTree でこのフォルダを開き、Unity モードで Main.prefab を選ぶ。
//
// ここで実行する git は「本リポジトリのソース管理」ではなく、検証用フィクスチャの作成
// （CLAUDE.md 規約 1 の例外）。作成先は .tmp/ 配下に限定する。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const LF = String.fromCharCode(10);

/** GameObject（id）と RectTransform（id + 1）。 */
function go(id, name, { father = 0, children = [], pos = '0' } = {}) {
  const tr = id + 1;
  return [
    `--- !u!1 &${id}`,
    'GameObject:',
    '  m_Component:',
    `  - component: {fileID: ${tr}}`,
    `  m_Name: ${name}`,
    '  m_IsActive: 1',
    `--- !u!224 &${tr}`,
    'RectTransform:',
    `  m_GameObject: {fileID: ${id}}`,
    `  m_AnchoredPosition: {x: ${pos}, y: 0}`,
    '  m_SizeDelta: {x: 100, y: 30}',
    '  m_Children:' + (children.length === 0 ? ' []' : ''),
    ...children.map((c) => `  - {fileID: ${c + 1}}`),
    `  m_Father: {fileID: ${father === 0 ? 0 : father + 1}}`,
  ];
}

const prefab = (...docs) => ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:', ...docs.flat(), ''].join(LF);

const base = prefab(
  go(100, 'Canvas', { children: [200] }),
  go(200, 'Panel', { father: 100, children: [300] }),
  go(300, 'Button', { father: 200 }),
);
const ours = prefab(
  go(100, 'Canvas_Ours', { children: [200] }),
  go(200, 'Panel', { father: 100, children: [300] }),
  go(300, 'Button', { father: 200 }),
);
const theirs = prefab(
  go(100, 'Canvas_Theirs', { children: [200] }),
  go(200, 'Panel', { father: 100, children: [300], pos: '40' }),
  go(300, 'Button', { father: 200, children: [400] }),
  go(400, 'Label', { father: 300 }),
);

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '.tmp/prefab-conflict-repo');
await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(repo, { recursive: true });

const git = (...args) => spawnSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true }).status;
const must = (...args) => {
  if (git(...args) !== 0) throw new Error(`git ${args.join(' ')} が失敗しました`);
};
const put = (text) => writeFileSync(join(repo, 'Main.prefab'), text, 'utf8');

must('init', '--initial-branch=main');
must('config', 'user.name', 'FeatherTree Demo');
must('config', 'user.email', 'demo@example.invalid');
must('config', 'core.autocrlf', 'false');
must('config', 'commit.gpgsign', 'false');

put(base);
must('add', '-A');
must('commit', '-m', '共通祖先');

must('switch', '-c', 'topic');
put(theirs);
must('commit', '-am', '相手側の編集');

must('switch', 'main');
put(ours);
must('commit', '-am', '自分側の編集');

// 衝突で exit 1 になるのが正しい
git('merge', 'topic');
process.stdout.write(`作成しました: ${repo}${LF}`);
