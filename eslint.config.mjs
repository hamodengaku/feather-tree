import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';

export default tseslint.config(
  { ignores: ['out/**', 'release/**', '.cache/**', '.tmp/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    // Node 側（ビルドスクリプト・git 層・core 層・main・preload）
    files: [
      'scripts/**/*.mjs',
      '*.mjs',
      '*.cjs',
      '*.ts',
      'packages/{base-contract,base-core,base-electron,git,core,ipc,main,preload}/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // Svelte の <script lang="ts"> を TypeScript として解析させる
    // .svelte と runes を使う .svelte.ts の両方を svelte パーサで扱う
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
      globals: globals.browser,
    },
  },
  {
    // View 層（Node API は存在しない。docs/01-architecture.md 2 章）
    files: ['packages/{renderer,base-ui}/**/*.ts', 'packages/renderer/**/*.svelte'],
    languageOptions: { globals: globals.browser },
  },
  {
    rules: {
      // docs/01-architecture.md 10 章: リポジトリ由来の文字列を生 HTML として描画しない
      'svelte/no-at-html-tags': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
    },
  },
);
