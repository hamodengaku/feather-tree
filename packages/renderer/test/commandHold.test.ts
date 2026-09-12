import { describe, expect, it } from 'vitest';
import type { CommandStartEvent } from '@feathertree/ipc';
import { CommandHold } from '../src/lib/commandHold.svelte.js';

/*
 * コマンドバーの滞留（決定 26）。
 *
 * 最小時間は短く差し替えて実時間で待つ（このリポジトリのテストは偽タイマーを使わない）。
 * 待ち時間には余裕を持たせる。この環境はファイル I/O が遅く、時刻の刻みも粗い。
 */
const MIN = 60;

function cmd(opId: string, ...args: string[]): CommandStartEvent {
  return { sessionId: 's1', opId, args };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('CommandHold', () => {
  it('実行中はそのまま出す', () => {
    const hold = new CommandHold(MIN);

    hold.update(cmd('1', 'status'));

    expect(hold.shown?.args).toEqual(['status']);
    hold.dispose();
  });

  it('すぐ終わっても最小時間までは消さない', async () => {
    const hold = new CommandHold(MIN);
    hold.update(cmd('1', 'status'));

    hold.update(null);
    expect(hold.shown).not.toBeNull();

    await wait(MIN / 2);
    expect(hold.shown).not.toBeNull();

    await wait(MIN);
    expect(hold.shown).toBeNull();
    hold.dispose();
  });

  it('最小時間より長くかかったものは、終わった時点で消える', async () => {
    const hold = new CommandHold(MIN);
    hold.update(cmd('1', 'fetch', 'origin'));

    await wait(MIN * 2);
    hold.update(null);

    // 余分な滞留は付かない
    expect(hold.shown).toBeNull();
    hold.dispose();
  });

  it('滞留中に次が来たら差し替え、時計も取り直す', async () => {
    const hold = new CommandHold(MIN);
    hold.update(cmd('1', 'status'));
    hold.update(null);

    await wait(MIN / 2);
    hold.update(cmd('2', 'for-each-ref'));
    expect(hold.shown?.args).toEqual(['for-each-ref']);

    // 1 個目の予約が生きていたらここで消えてしまう
    hold.update(null);
    await wait(MIN / 2 + 10);
    expect(hold.shown?.args).toEqual(['for-each-ref']);

    await wait(MIN);
    expect(hold.shown).toBeNull();
    hold.dispose();
  });

  it('同じコマンドを流し込み直しても時計は動かさない', async () => {
    const hold = new CommandHold(MIN);
    const running = cmd('1', 'status');
    hold.update(running);

    await wait(MIN / 2);
    hold.update(running);
    hold.update(null);

    await wait(MIN / 2 + 20);
    expect(hold.shown).toBeNull();
    hold.dispose();
  });

  it('dispose すれば予約は残らない', async () => {
    const hold = new CommandHold(MIN);
    hold.update(cmd('1', 'status'));
    hold.update(null);

    hold.dispose();

    await wait(MIN * 2);
    // 破棄後にタイマーが動いて状態を触ることはない
    expect(hold.shown).not.toBeNull();
  });
});
