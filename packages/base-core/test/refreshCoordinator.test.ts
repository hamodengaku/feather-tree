import { describe, expect, it } from 'vitest';
import { RefreshCoordinator } from '../src/index.js';

const tick = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

describe('RefreshCoordinator（土台）', () => {
  it('同じキーの要求を直列化する', async () => {
    const c = new RefreshCoordinator();
    const order: string[] = [];

    const task = (name: string) => async (): Promise<void> => {
      order.push(`${name}:start`);
      await tick(20);
      order.push(`${name}:end`);
    };

    await Promise.all([c.request('s1', task('a')), c.request('s1', task('b'))]);

    // 並行実行されていない（start と end が交互に入り込まない）
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('連打しても保留は 1 件だけに畳まれる', async () => {
    const c = new RefreshCoordinator();
    let runCount = 0;

    const task = async (): Promise<void> => {
      runCount += 1;
      await tick(30);
    };

    // 実行中に 5 回追加要求 → 実行は 1 回目 + 最後の 1 回だけ
    const promises = [c.request('s1', task)];
    for (let i = 0; i < 5; i += 1) promises.push(c.request('s1', task));
    await Promise.all(promises);
    await tick(50);

    expect(runCount).toBe(2);
  });

  it('別キーは並行して走る（タブごとに独立）', async () => {
    const c = new RefreshCoordinator();
    const running: string[] = [];
    let maxConcurrent = 0;

    const task = (name: string) => async (): Promise<void> => {
      running.push(name);
      maxConcurrent = Math.max(maxConcurrent, running.length);
      await tick(20);
      running.splice(running.indexOf(name), 1);
    };

    await Promise.all([c.request('s1', task('a')), c.request('s2', task('b'))]);
    expect(maxConcurrent).toBe(2);
  });

  it('実行中は isBusy が真になる', async () => {
    const c = new RefreshCoordinator();
    const p = c.request('s1', () => tick(30));
    expect(c.isBusy('s1')).toBe(true);
    await p;
    expect(c.isBusy('s1')).toBe(false);
  });

  it('discard で保留を捨てられる（タブを閉じたとき）', async () => {
    const c = new RefreshCoordinator();
    let runCount = 0;
    const task = async (): Promise<void> => {
      runCount += 1;
      await tick(30);
    };

    const first = c.request('s1', task);
    void c.request('s1', task);
    c.discard('s1');
    await first;
    await tick(50);

    expect(runCount).toBe(1);
  });

  it('タスクが失敗しても後続をブロックしない', async () => {
    const c = new RefreshCoordinator();
    await expect(c.request('s1', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(c.request('s1', () => Promise.resolve())).resolves.toBeUndefined();
  });
});
