import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const root = __dirname;

/**
 * 本番ビルドの CSP から Vite HMR 用の localhost 許可を落とす（脆弱性診断 §7 Low）。
 *
 * index.html / splash.html は開発・本番で同じ HTML ファイルを共有しているため、
 * `connect-src` に入れた `ws://localhost:* http://localhost:*`（dev サーバの HMR 用）が
 * そのまま配布物にも残ってしまう。単独では悪用できないが、他の脆弱性と組み合わさった
 * ときの攻撃対象領域を広げるため、ビルド時（transformIndexHtml、= command 'build'）だけ
 * この 2 語を落とす。dev（electron-vite dev）では手を加えず HMR を維持する。
 *
 * 純関数にしてあるのは、`npm run build` を実行できない状況でも動作を確認できるようにするため
 * （呼び出し側は下の transformIndexHtml のみ）。
 */
export function stripDevConnectSrc(html: string): string {
  return html.replace(/connect-src([^";]*)/, (_match, sources: string) => {
    const kept = sources
      .split(/\s+/)
      .filter((s) => s.length > 0 && s !== 'ws://localhost:*' && s !== 'http://localhost:*');
    return 'connect-src ' + (kept.length > 0 ? kept.join(' ') : "'none'");
  });
}

function productionCspPlugin(command: 'build' | 'serve'): Plugin {
  return {
    name: 'feathertree-production-csp',
    transformIndexHtml(html) {
      return command === 'build' ? stripDevConnectSrc(html) : html;
    },
  };
}

/**
 * main / preload / renderer の 3 ターゲット。
 *
 * - 内部パッケージ（@feathertree/*）は package.json の main が TS ソースを指しており、
 *   externalizeDepsPlugin を使わずバンドルに取り込む。実行時依存はゼロ。
 * - preload は sandbox: true で動くため CJS 単一ファイルでなければならない。
 * - CSP を本番だけ絞るため（stripDevConnectSrc）、関数形式の defineConfig で command を受け取る。
 */
export default defineConfig(({ command }) => ({
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
      /*
       * 小さい画像を data URI に埋め込ませない。
       * ロゴは srcset で密度ごとの素材を並べる（AppIcon.svelte）が、data URI は
       * `data:image/png;base64,` 自体がカンマを含むため、srcset の区切りと紛らわしい。
       * 実ファイル参照にしておけば読みづらさも曖昧さも無い。
       */
      assetsInlineLimit: 0,
      /*
       * 入力は 2 つ。index.html が本体、splash.html が起動時のスプラッシュ（決定 28）。
       * スプラッシュは別の BrowserWindow なので、独立した HTML とエントリが必要になる。
       * 出力は out/renderer/ の直下に同名で並び、electron-builder の files（out/**）に入る。
       */
      rollupOptions: {
        input: {
          index: resolve(root, 'packages/renderer/index.html'),
          splash: resolve(root, 'packages/renderer/splash.html'),
        },
      },
    },
    plugins: [svelte(), productionCspPlugin(command)],
  },
}));
