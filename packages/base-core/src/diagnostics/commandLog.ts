export interface CommandLogEntry {
  readonly seq: number;
  /** ISO 8601。 */
  readonly at: string;
  readonly cwd: string;
  /** 実行した引数の完全な列。伏せない。 */
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly elapsedMs: number;
  /** 失敗時のみ。 */
  readonly stderr?: string;
  /**
   * どのまとまりの実行か（識別子の意味はアプリが決める。FeatherTree ではタブのセッション id）。
   * 無ければどのまとまりにも属さない（セッションが立つ前のクローンなど）。
   */
  readonly scope?: string;
}

/**
 * 外部コマンドの実行記録（リングバッファ）。
 *
 * 土台としての意図: 確認ダイアログを減らす代わりに、
 * **何が実行されたかを完全に見せる**ことで信頼を担保する。
 * UI の「実行ログ」パネル（「コマンド」タブ）がこれを表示する。引数は伏せずに全部記録する。
 */
export class CommandLog {
  readonly #capacity: number;
  #entries: CommandLogEntry[] = [];
  #nextSeq = 1;
  readonly #listeners = new Set<(entry: CommandLogEntry) => void>();

  constructor(capacity = 500) {
    this.#capacity = capacity;
  }

  add(entry: Omit<CommandLogEntry, 'seq' | 'at'>): CommandLogEntry {
    const full: CommandLogEntry = {
      ...entry,
      seq: this.#nextSeq,
      at: new Date().toISOString(),
    };
    this.#nextSeq += 1;
    this.#entries.push(full);
    if (this.#entries.length > this.#capacity) {
      this.#entries = this.#entries.slice(this.#entries.length - this.#capacity);
    }
    for (const listener of this.#listeners) {
      try {
        listener(full);
      } catch {
        // 通知先の失敗で、記録した側（コマンドの実行）を巻き込まない
      }
    }
    return full;
  }

  /**
   * 記録が増えたときに呼ぶ。購読解除用の関数を返す。
   * 表示側が「取り直すきっかけ」を待たずに、増えた分をそのまま受け取るため。
   */
  onAdd(listener: (entry: CommandLogEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 新しい順に返す。 */
  recent(limit = 100): CommandLogEntry[] {
    return this.#entries.slice(-limit).reverse();
  }

  get size(): number {
    return this.#entries.length;
  }

  clear(): void {
    this.#entries = [];
  }
}
