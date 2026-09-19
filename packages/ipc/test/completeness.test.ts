import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANNELS } from '../src/index.js';

const root = resolve(import.meta.dirname, '../../..');
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8');

/**
 * 契約の取りこぼしを機械的に検出する。
 *
 * main のハンドラ登録・preload の公開・型定義は 3 箇所に分かれているため、
 * 片方だけ足して忘れる事故が起きやすい。ここで突き合わせる。
 */
describe('IPC 契約の網羅性', () => {
  const contract = read('packages/ipc/src/contract.ts');
  /*
   * ハンドラ登録は register.ts が大半だが、更新通知（決定 29）は専用ファイル
   * （handlers/update.ts）に分けて index.ts から登録している。register.ts 1 本を見ると
   * 常に「取りこぼし」に見えてしまうので、main 側の登録は 2 ファイルを合わせて見る。
   */
  const register = read('packages/main/src/handlers/register.ts') + read('packages/main/src/handlers/update.ts');
  const preload = read('packages/preload/src/index.ts');

  /** FeatherTreeBridge に宣言されたメソッド名。 */
  const bridgeMethods = (() => {
    const start = contract.indexOf('export interface FeatherTreeBridge {');
    expect(start).toBeGreaterThan(-1);
    const body = contract.slice(start);
    const names = new Set<string>();
    for (const m of body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\(/gm)) {
      const name = m[1];
      if (name !== undefined) names.add(name);
    }
    return [...names];
  })();

  /** リクエスト応答チャネル（通知の event* は除く）。 */
  const requestChannels = Object.entries(CHANNELS).filter(([key]) => !key.startsWith('event'));

  it('bridge のメソッドが 20 個以上宣言されている（取り違え検出の前提）', () => {
    expect(bridgeMethods.length).toBeGreaterThanOrEqual(20);
  });

  it('すべてのリクエスト応答チャネルが main に登録されている', () => {
    const missing = requestChannels
      .filter(([key]) => !register.includes(`CHANNELS.${key}`))
      .map(([key]) => key);
    expect(missing).toEqual([]);
  });

  it('すべてのリクエスト応答チャネルが preload で公開されている', () => {
    const missing = requestChannels
      .filter(([key]) => !preload.includes(`CHANNELS.${key}`))
      .map(([key]) => key);
    expect(missing).toEqual([]);
  });

  it('通知チャネルが preload で購読されている', () => {
    for (const key of Object.keys(CHANNELS).filter((k) => k.startsWith('event'))) {
      expect(preload).toContain(`CHANNELS.${key}`);
    }
  });

  it('bridge の全メソッドが preload に実装されている', () => {
    const missing = bridgeMethods.filter((name) => !preload.includes(name + ':'));
    expect(missing).toEqual([]);
  });

  it('チャネル名が重複していない', () => {
    const values = Object.values(CHANNELS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('preload はチャネル名の文字列リテラルを直接書かない（CHANNELS 経由のみ）', () => {
    // 'app:getInfo' のようなリテラルが preload に直接現れていないこと
    for (const value of Object.values(CHANNELS)) {
      expect(preload).not.toContain(`'${value}'`);
    }
  });

  it('renderer は electron も Node 組み込みも import していない', () => {
    const appState = read('packages/renderer/src/lib/appState.svelte.ts');
    const bridge = read('packages/renderer/src/bridge.ts');
    for (const source of [appState, bridge]) {
      expect(source).not.toContain("from 'electron'");
      expect(source).not.toContain("from 'node:");
    }
  });
});
