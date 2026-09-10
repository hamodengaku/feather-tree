import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8');

/**
 * View の重なり順の取りこぼしを機械的に検出する。
 *
 * 実際に起きた事故: ブランチ作成ダイアログをブランチペインの中に置いたため、
 * position: fixed でも DOM 上で後ろに来るペインが上に描画され、
 * モーダルの背後にあるファイル行がマウスオーバーやクリックを拾ってしまった。
 * 「DOM の記述順に依存しない」ことをここで担保する。
 *
 * renderer 側ではなくここに置くのは、ソースを読むのに node:fs が要るため
 * （renderer は no-node-in-renderer で Node 組み込みを禁じている）。
 * completeness.test.ts と同じ「静的な取りこぼし検出」の置き場。
 */
describe('View の重なり順（--app-layer-*）', () => {
  const tokens = read('packages/renderer/src/theme/tokens.css');
  const appSvelte = read('packages/renderer/src/App.svelte');

  /** tokens.css が :root で定義している層。 */
  const defined = new Set([...tokens.matchAll(/(--app-layer-[a-z-]+):\s*(\d+);/g)].map((m) => m[1] ?? ''));

  interface Source {
    readonly rel: string;
    readonly name: string;
    readonly text: string;
  }

  const sources = (dir: string): Source[] =>
    readdirSync(resolve(root, dir))
      .filter((f: string) => f.endsWith('.svelte'))
      .map((f: string) => ({ rel: `${dir}/${f}`, name: f.replace('.svelte', ''), text: read(`${dir}/${f}`) }));

  const PANES = 'packages/renderer/src/panes';
  const components: Source[] = [
    ...sources('packages/renderer/src/components'),
    ...sources(PANES),
    { rel: 'packages/renderer/src/App.svelte', name: 'App', text: appSvelte },
  ];

  /** 背面を覆うモーダル（backdrop 付き）を持つコンポーネント。 */
  const modals = components.filter(
    (c) => c.name !== 'App' && c.text.includes('var(--app-layer-modal-backdrop)'),
  );

  /** `{ ... }` の単位で CSS ルールを取り出す（入れ子のない CSS 前提）。 */
  const fixedRulesOf = (text: string): string[] =>
    [...text.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]).filter((block) => /position:\s*fixed/.test(block));

  it('層のトークンが定義されている', () => {
    expect([...defined].sort()).toEqual([
      '--app-layer-menu',
      '--app-layer-menu-backdrop',
      '--app-layer-modal',
      '--app-layer-modal-backdrop',
    ]);
  });

  it('position: fixed の要素は必ず層のトークンで z-index を指定する', () => {
    const missing: string[] = [];
    for (const { rel, text } of components) {
      for (const block of fixedRulesOf(text)) {
        if (!/z-index:\s*var\(--app-layer-[a-z-]+\)/.test(block)) missing.push(rel);
      }
    }
    expect(missing).toEqual([]);
  });

  it('参照している層のトークンはすべて定義済み', () => {
    const unknown: string[] = [];
    for (const { rel, text } of components) {
      for (const m of text.matchAll(/z-index:\s*var\((--app-layer-[a-z-]+)\)/g)) {
        if (!defined.has(m[1] ?? '')) unknown.push(`${rel}: ${m[1] ?? ''}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('モーダルは App.svelte の最上位に置く', () => {
    // 前提の確認: 検出漏れした状態で緑になっていないこと
    expect(modals.length).toBeGreaterThanOrEqual(4);
    for (const modal of modals) {
      expect(appSvelte, `${modal.name} は App.svelte に置く`).toContain(`<${modal.name}`);
    }
  });

  it('ペインの中にモーダルを置かない（後続のペインに隠れるため）', () => {
    const violations: string[] = [];
    for (const pane of sources(PANES)) {
      for (const modal of modals) {
        if (pane.text.includes(`<${modal.name}`)) violations.push(`${pane.rel}: ${modal.name}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
