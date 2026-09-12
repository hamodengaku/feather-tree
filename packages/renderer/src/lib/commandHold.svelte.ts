import type { CommandStartEvent } from '@feathertree/ipc';

/**
 * コマンドバーに出したものを、終わったあとも最低これだけは残す（ミリ秒）。
 *
 * git の読み取り系は数十 ms で終わる。素直に消すと、出るアニメーションの途中で
 * 打ち切られて薄いまま消え、何が走ったのか読めない。
 */
export const COMMAND_MIN_DISPLAY_MS = 500;

/**
 * 「実行中のコマンド」を、表示のための値へ均す係。
 *
 * 実行の有無をそのまま映すのではなく、**出したものは最低時間だけ残す**。
 * 出てから数えるので、時間のかかるコマンドには余分な滞留が付かない
 * （2 秒かかったものは終わった瞬間に消え始める）。
 *
 * 連続実行（status → for-each-ref）の隙間も、この滞留が埋める。
 * 埋めないと実行の切れ目で 1 フレーム空白になり、次のコマンドがまた
 * 出るアニメーションからやり直しになる。
 */
export class CommandHold {
  #shown = $state<CommandStartEvent | null>(null);
  /** #shown を出した時刻。 */
  #shownAt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #minMs: number;

  /** minMs を差し替えられるのはテストのため。 */
  constructor(minMs: number = COMMAND_MIN_DISPLAY_MS) {
    this.#minMs = minMs;
  }

  /** 今バーに出すもの。 */
  get shown(): CommandStartEvent | null {
    return this.#shown;
  }

  /**
   * 実行中のコマンド（無ければ null）を流し込む。
   * 新しいものが来たら即差し替え、最小時間の計測もそこから取り直す。
   */
  update(running: CommandStartEvent | null): void {
    if (running !== null) {
      this.#cancel();
      if (this.#shown?.opId !== running.opId) {
        this.#shown = running;
        this.#shownAt = Date.now();
      }
      return;
    }

    // 既に消す予約が入っているなら二重に取らない
    if (this.#shown === null || this.#timer !== null) return;

    const remaining = this.#minMs - (Date.now() - this.#shownAt);
    if (remaining <= 0) {
      this.#shown = null;
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#shown = null;
    }, remaining);
  }

  /** 予約したタイマーを捨てる。コンポーネントが消えるときに呼ぶ。 */
  dispose(): void {
    this.#cancel();
  }

  #cancel(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}
