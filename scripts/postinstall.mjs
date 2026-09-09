// Electron 本体バイナリを「リポジトリ内キャッシュ」へ取得する。
//
// electron の postinstall は既定で %LOCALAPPDATA%\electron\Cache へ書き込む。
// CLAUDE.md 規約 2 によりリポジトリ外へは書けないため、ELECTRON_CACHE を
// この子プロセス内のみで差し替えて実行する（システムには残らない）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const electronDir = resolve(root, 'node_modules/electron');
const installScript = resolve(electronDir, 'install.js');

if (!existsSync(installScript)) {
  console.log('[postinstall] electron が未インストールのためスキップ');
  process.exit(0);
}
if (existsSync(resolve(electronDir, 'dist'))) {
  console.log('[postinstall] electron バイナリは既に展開済み');
  process.exit(0);
}

const cache = resolve(root, '.cache/electron');
mkdirSync(cache, { recursive: true });
console.log(`[postinstall] electron cache -> ${cache}`);

const result = spawnSync(process.execPath, [installScript], {
  cwd: electronDir,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_CACHE: cache, electron_config_cache: cache },
});
process.exit(result.status ?? 1);
