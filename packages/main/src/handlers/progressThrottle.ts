/**
 * 進捗通知の間引き（docs/01-architecture.md 6 章）。
 *
 * git は「% が変わったとき／約 1 秒ごと」にしか進捗を出さないので負荷はもともと小さいが、
 * LFS やサーバー側の計数で行が詰まったときに IPC を溢れさせない保険として、送る間隔を空ける。
 *
 *  - 最初の 1 回と urgent（段階の開始・終了）はすぐ送る
 *  - それ以外は、前回から interval 経つまで溜め、溜まった最後の値だけを送る（途中の値は捨てる）
 */
export interface ProgressThrottle<T> {
  push(value: T, urgent: boolean): void;
  /** 溜まっている値があればすぐ送る。 */
  flush(): void;
  /** 溜まっている値を捨て、タイマーを止める。終わった操作の値を後から送らないため。 */
  dispose(): void;
}

export function createProgressThrottle<T>(send: (value: T) => void, intervalMs: number): ProgressThrottle<T> {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const sendNow = (value: T): void => {
    clearTimer();
    pending = null;
    lastSentAt = Date.now();
    send(value);
  };

  const flush = (): void => {
    const held = pending;
    if (held === null) {
      clearTimer();
      return;
    }
    sendNow(held.value);
  };

  return {
    push(value, urgent) {
      const elapsed = Date.now() - lastSentAt;
      if (urgent || elapsed >= intervalMs) {
        sendNow(value);
        return;
      }
      pending = { value };
      timer ??= setTimeout(flush, intervalMs - elapsed);
    },
    flush,
    dispose() {
      clearTimer();
      pending = null;
    },
  };
}
