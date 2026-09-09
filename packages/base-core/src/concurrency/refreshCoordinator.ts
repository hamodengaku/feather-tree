/**
 * 同じキーに対する非同期処理を直列化し、実行中なら後発を 1 件だけ保留する調停器。
 *
 * 土台としての意図: 「更新」の連打で重い処理が積み上がるのを防ぐ。
 * 実行中に何度要求されても、走るのは「今の 1 件 + 最後の 1 件」だけになる。
 * キーを分ければ（タブごとなど）それぞれ独立して並行に走る。
 */
export class RefreshCoordinator {
  readonly #running = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, () => Promise<void>>();

  /**
   * 要求を出す。返る Promise はこの要求（または自分を置き換えた後続要求）の完了を待つ。
   * 実行中の要求があり、かつ既に保留がある場合は保留を置き換える（最新だけ残す）。
   */
  async request(key: string, task: () => Promise<void>): Promise<void> {
    const running = this.#running.get(key);
    if (running !== undefined) {
      this.#pending.set(key, task);
      await running;
      // 自分が保留から実行へ昇格したかは #drain 側が処理する
      const next = this.#running.get(key);
      if (next !== undefined) await next;
      return;
    }

    await this.#run(key, task);
  }

  /** 実行中・保留中の要求があるか。 */
  isBusy(key: string): boolean {
    return this.#running.has(key) || this.#pending.has(key);
  }

  /** 保留を捨てる（タブを閉じたときなど）。 */
  discard(key: string): void {
    this.#pending.delete(key);
  }

  async #run(key: string, task: () => Promise<void>): Promise<void> {
    const promise = task().finally(() => {
      this.#running.delete(key);
      const pending = this.#pending.get(key);
      if (pending !== undefined) {
        this.#pending.delete(key);
        void this.#run(key, pending);
      }
    });
    this.#running.set(key, promise);
    await promise;
  }
}
