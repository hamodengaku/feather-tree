/**
 * 層の参照方向を機械的に強制する（docs/01-architecture.md / docs/04-foundation.md）。
 * 違反は npm run lint:deps でエラーになる。
 *
 * 2 種類の境界を守る。
 *   1. 土台（packages/base-*）と FeatherTree 固有（それ以外）の境界
 *      → 土台は FeatherTree を一切知らない。これが流用可能性の担保
 *   2. 層の境界（git -> core -> main / renderer は View から git に到達できない）
 */
const APP_PACKAGES = '^packages/(git|core|ipc|main|preload|renderer)/';

module.exports = {
  forbidden: [
    // ---------------------------------------------- 土台と FeatherTree の境界
    {
      name: 'base-must-not-know-app',
      comment:
        '土台は FeatherTree 固有のパッケージを参照しない。これを破ると他プロジェクトへ流用できなくなる',
      severity: 'error',
      from: { path: '^packages/base-' },
      to: { path: APP_PACKAGES },
    },
    {
      name: 'base-contract-has-no-deps',
      comment: 'base-contract は依存ゼロ（main / renderer のどちらからでも安全に import できる）',
      severity: 'error',
      from: { path: '^packages/base-contract/' },
      // 自分自身の中の import は当然許す。他パッケージへの依存を禁止する
      to: { path: '^packages/(?!base-contract/)' },
    },
    {
      name: 'no-electron-outside-base-electron',
      comment: 'base-core / base-contract / base-ui は electron を知らない',
      severity: 'error',
      from: { path: '^packages/base-(core|contract|ui)/' },
      to: { path: '^electron$|^node_modules/electron' },
    },
    {
      name: 'no-node-in-base-ui',
      comment: 'base-ui は renderer 用なので Node 組み込みを使えない',
      severity: 'error',
      from: { path: '^packages/base-ui/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'no-node-in-base-contract',
      comment: 'base-contract は型と純関数のみ。Node にも依存しない',
      severity: 'error',
      from: { path: '^packages/base-contract/' },
      to: { dependencyTypes: ['core'] },
    },

    // ---------------------------------------------- 層の境界（FeatherTree 側）
    {
      name: 'no-electron-in-git-core',
      comment: 'git 層 / core 層は electron を知らない（Electron を捨てても動く）',
      severity: 'error',
      from: { path: '^packages/(git|core)/' },
      to: { path: '^electron$|^node_modules/electron' },
    },
    {
      name: 'no-node-in-renderer',
      comment: 'View 層は Node API に到達してはならない（sandbox: true の前提）',
      severity: 'error',
      from: { path: '^packages/renderer/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'no-electron-in-renderer',
      comment: 'View 層は electron を直接 import しない（preload 経由のみ）',
      severity: 'error',
      from: { path: '^packages/renderer/' },
      to: { path: '^electron$|^node_modules/electron' },
    },
    {
      name: 'renderer-only-ipc-and-base-ui',
      comment: 'View 層が参照できるのは @feathertree/ipc と土台の base-ui / base-contract だけ',
      severity: 'error',
      from: { path: '^packages/renderer/' },
      to: { path: '^packages/(git|core|main|preload|base-core|base-electron)/' },
    },
    {
      name: 'no-upward-from-git',
      comment: 'git 層は上位層を参照しない',
      severity: 'error',
      from: { path: '^packages/git/' },
      to: { path: '^packages/(core|ipc|main|preload|renderer)/' },
    },
    {
      name: 'no-upward-from-core',
      comment: 'core 層は上位層を参照しない',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^packages/(main|preload|renderer)/' },
    },
    {
      name: 'ipc-has-no-app-impl',
      comment: 'ipc は契約のみ。実装を持つパッケージを参照しない（土台の base-contract は可）',
      severity: 'error',
      from: { path: '^packages/ipc/' },
      to: { path: '^packages/(git|core|main|preload|renderer|base-core|base-electron|base-ui)/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(out|release|[.]cache|[.]tmp)/' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.svelte'],
    },
  },
};
