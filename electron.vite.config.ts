import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const root = __dirname;

/**
 * main / preload / renderer の 3 ターゲット。
 *
 * - 内部パッケージ（@feathertree/*）は package.json の main が TS ソースを指しており、
 *   externalizeDepsPlugin を使わずバンドルに取り込む。実行時依存はゼロ。
 * - preload は sandbox: true で動くため CJS 単一ファイルでなければならない。
 */
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      // 既存の出力へ上書きすると rollup がネイティブクラッシュする（Phase 4 で判明）
      emptyOutDir: true,
      minify: false,
      lib: { entry: resolve(root, 'packages/main/src/index.ts') },
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: 'index.js' },
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      emptyOutDir: true,
      minify: false,
      lib: { entry: resolve(root, 'packages/preload/src/index.ts') },
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: 'index.js' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'packages/renderer'),
    build: {
      outDir: resolve(root, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(root, 'packages/renderer/index.html') },
    },
    plugins: [svelte()],
  },
});
