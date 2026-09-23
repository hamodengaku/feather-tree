import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // .svelte.ts の runes をコンパイルするために必要
  plugins: [svelte({ configFile: false, compilerOptions: { runes: true } })],
  test: {
    // git 層 / core 層 / main / renderer はいずれも Electron 本体を必要としない
    include: ['packages/{base-contract,base-core,base-electron,base-ui,git,unity,core,ipc,main,renderer}/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'threads',
    reporters: ['default'],
  },
});
