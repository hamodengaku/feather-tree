// electron-builder を「リポジトリ内キャッシュ」で実行するラッパ。
//
// CLAUDE.md 規約 2/3: %LOCALAPPDATA% への書き込みを避けるため、キャッシュ先を
// すべてリポジトリ内に向ける。環境変数の設定はこの子プロセス内のみで、
// ユーザー環境・システムには一切残らない。
//
// 注意（Phase 0 で判明）:
//   ELECTRON_BUILDER_CACHE は electron-builder 自身のキャッシュ（7zip / nsis 等）にしか効かない。
//   Electron 本体 zip の取得先は ELECTRON_CACHE でも変わらないため、
//   --config.electronDownload.cache で明示的に上書きする必要がある。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const builderCache = resolve(root, '.cache/electron-builder');
const electronCache = resolve(root, '.cache/electron');
mkdirSync(builderCache, { recursive: true });
mkdirSync(electronCache, { recursive: true });

const pkgPath = resolve(root, 'node_modules/electron-builder/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['electron-builder'];
const cli = resolve(root, 'node_modules/electron-builder', binRel);

// 追加引数はそのまま electron-builder へ渡す（--dir で win-unpacked のみ作る等）
const extra = process.argv.slice(2);
// --publish never を固定する（決定 22）。electron-builder.yml の publish: null と二重の保険。
// 開発機の環境に GH_TOKEN が残っていても、それだけで Releases へ誤アップロードしないようにする
// （公開はソースのみで、成果物は人間が手動で Releases に上げる方針のため）。
const args = [
  '--win',
  ...extra,
  `--config.electronDownload.cache=${electronCache}`,
  '--publish',
  'never',
];

console.log(`[dist] electron-builder cache -> ${builderCache}`);
console.log(`[dist] electron download cache -> ${electronCache}`);

const result = spawnSync(process.execPath, [cli, ...args], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_BUILDER_CACHE: builderCache,
    ELECTRON_CACHE: electronCache,
  },
});

process.exit(result.status ?? 1);
