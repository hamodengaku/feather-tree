import { describe, expect, it } from 'vitest';
import { HandoverLatch, SPLASH_MIN_MS, remainingHoldMs } from '../src/splashWindow.js';

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

/*
 * 引き渡しのラッチ（docs/01-architecture.md 11 章 2026-09-19 追加分）。
 *
 * 1 つのフラグにまとめていたころは、保険タイマーが鳴った後に来た ready-to-show が
 * 即 return し、show: false のまま見えないウィンドウを抱えたプロセスが常駐していた。
 * 「スプラッシュを閉じた」と「本体を出した」を分けたことをここで押さえる。
 */
describe('HandoverLatch', () => {
  it('正常な経路: ready-to-show で本体を出し、スプラッシュを閉じる', () => {
    const latch = new HandoverLatch();
    expect(latch.decide('main-ready', true)).toEqual({ showMain: true, closeSplash: true });
    expect(latch.mainShown).toBe(true);
    expect(latch.splashClosed).toBe(true);
  });

  it('同じことを二度はしない（ready-to-show が二度来ても show は 1 回）', () => {
    const latch = new HandoverLatch();
    latch.decide('main-ready', true);
    expect(latch.decide('main-ready', true)).toEqual({ showMain: false, closeSplash: false });
  });

  it('保険タイマーはスプラッシュだけを閉じる（本体は出さない）', () => {
    const latch = new HandoverLatch();
    expect(latch.decide('safety-timer', true)).toEqual({ showMain: false, closeSplash: true });
    expect(latch.mainShown).toBe(false);
    expect(latch.splashClosed).toBe(true);
  });

  /** これが以前の致命傷。保険タイマーが先に鳴ったら本体は永久に出なかった。 */
  it('保険タイマーが先に鳴っても、後から来た本体は必ず show される', () => {
    const latch = new HandoverLatch();
    latch.decide('safety-timer', true);

    expect(latch.decide('main-ready', true)).toEqual({ showMain: true, closeSplash: false });
    expect(latch.mainShown).toBe(true);
  });

  it('本体がまだ無い時点で保険タイマーが鳴っても、後から来た本体は show される', () => {
    const latch = new HandoverLatch();
    expect(latch.decide('safety-timer', false)).toEqual({ showMain: false, closeSplash: true });
    expect(latch.decide('main-ready', true)).toEqual({ showMain: true, closeSplash: false });
  });

  it('起動処理が失敗したら、スプラッシュは閉じ、本体があれば出す', () => {
    const latch = new HandoverLatch();
    expect(latch.decide('startup-failed', true)).toEqual({ showMain: true, closeSplash: true });
  });

  /*
   * 本体が無い状態でスプラッシュを閉じるとアプリは終了する（window-all-closed）。
   * 起動に失敗しているのだからそれが正しい。閉じるボタンの無い板を残すほうが害が大きい。
   */
  it('本体が無ければ show はしないが、スプラッシュは必ず閉じる', () => {
    const latch = new HandoverLatch();
    expect(latch.decide('startup-failed', false)).toEqual({ showMain: false, closeSplash: true });
  });

  it('本体を出した後に保険タイマーが鳴っても何も起きない', () => {
    const latch = new HandoverLatch();
    latch.decide('main-ready', true);
    expect(latch.decide('safety-timer', true)).toEqual({ showMain: false, closeSplash: false });
  });
});
