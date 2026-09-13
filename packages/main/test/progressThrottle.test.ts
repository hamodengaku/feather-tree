import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgressThrottle } from '../src/handlers/progressThrottle.js';

describe('createProgressThrottle（進捗通知の間引き）', () => {
  let sent: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('最初の 1 回はすぐ送る', () => {
    const throttle = createProgressThrottle<number>((v) => sent.push(v), 200);
    throttle.push(1, false);
    expect(sent).toEqual([1]);
  });

  it('間隔内の値は溜め、間隔が明けたら最後の値だけを送る', () => {
    const throttle = createProgressThrottle<number>((v) => sent.push(v), 200);
    throttle.push(1, false);
    vi.advanceTimersByTime(50);
    throttle.push(2, false);
    throttle.push(3, false);
    expect(sent).toEqual([1]);

    vi.advanceTimersByTime(150);
    expect(sent).toEqual([1, 3]);

    // 溜まっていなければ、タイマーが来ても何も送らない
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([1, 3]);
  });

  it('urgent（段階の開始・終了）は間隔内でもすぐ送り、溜めていた値は捨てる', () => {
    const throttle = createProgressThrottle<number>((v) => sent.push(v), 200);
    throttle.push(1, false);
    throttle.push(2, false);
    throttle.push(3, true);
    expect(sent).toEqual([1, 3]);

    vi.advanceTimersByTime(500);
    expect(sent).toEqual([1, 3]);
  });

  it('間隔が明けた後の値は溜めずにすぐ送る', () => {
    const throttle = createProgressThrottle<number>((v) => sent.push(v), 200);
    throttle.push(1, false);
    vi.advanceTimersByTime(250);
    throttle.push(2, false);
    expect(sent).toEqual([1, 2]);
  });

  it('dispose した後は、溜めていた値を送らない', () => {
    const throttle = createProgressThrottle<number>((v) => sent.push(v), 200);
    throttle.push(1, false);
    throttle.push(2, false);
    throttle.dispose();
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([1]);
  });

  it('flush は溜めていた値をすぐ送る', () => {
    const throttle = createProgressThrottle<number>((v) => sent.push(v), 200);
    throttle.push(1, false);
    throttle.push(2, false);
    throttle.flush();
    expect(sent).toEqual([1, 2]);
  });
});
