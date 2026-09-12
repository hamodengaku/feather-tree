import { describe, expect, it } from 'vitest';
import { SPLASH_MIN_MS, remainingHoldMs } from '../src/splashWindow.js';

/*
 * スプラッシュの最低表示時間（決定 28）。
 *
 * BrowserWindow は Electron 無しでは作れないので、テストで押さえられるのはこの純関数だけ。
 * ウィンドウの生成・フェード・閉じる順番は人間の実機確認に委ねる。
 *
 * ここが狂うと「一瞬光って消える」か「いつまでも閉じない」のどちらかになり、
 * 後者は閉じるボタンの無い板が残るので実害が大きい。
 */

describe('remainingHoldMs', () => {
  it('まだ最低表示時間に届いていなければ残りを返す', () => {
    expect(remainingHoldMs(1000, 1300, 1000)).toBe(700);
    expect(remainingHoldMs(1000, 1001, 1000)).toBe(999);
  });

  it('出した直後なら最低表示時間そのまま', () => {
    expect(remainingHoldMs(1000, 1000, 1000)).toBe(1000);
  });

  it('ちょうど最低表示時間なら待たない', () => {
    expect(remainingHoldMs(1000, 2000, 1000)).toBe(0);
  });

  it('超えていれば待たない（負の値を返さない）', () => {
    expect(remainingHoldMs(1000, 9999, 1000)).toBe(0);
  });

  /*
   * 時計が巻き戻ると経過が負になる（サマータイム・NTP の補正）。
   * 素朴に minMs - elapsed を返すと最低表示時間を超えて待ち続けることになる。
   */
  it('時計が巻き戻っても最低表示時間を超えて待たない', () => {
    expect(remainingHoldMs(5000, 1000, 1000)).toBe(1000);
  });

  it('既定は SPLASH_MIN_MS', () => {
    expect(remainingHoldMs(0, 0)).toBe(SPLASH_MIN_MS);
    expect(remainingHoldMs(0, SPLASH_MIN_MS)).toBe(0);
  });

  it('最低表示時間が 0 なら常に待たない（将来スプラッシュを切れるようにしたとき用）', () => {
    expect(remainingHoldMs(1000, 1000, 0)).toBe(0);
  });
});
