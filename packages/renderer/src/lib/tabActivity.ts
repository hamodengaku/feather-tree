import { SvelteSet } from 'svelte/reactivity';

/**
 * タブの読み込み帯の発動条件（docs/01-architecture.md 8 章）。
 *
 * 帯が約束するのは **「このタブに出ている内容は古く、まもなく変わる」** こと。
 * 「git が走っている」でも「アプリが忙しい」でもない。
 *
 * 信号は 2 つあり、どちらか片方では足りないので和集合を取る。
 *   意図（begin / end）: renderer が表示を更新する操作を始めてから、画面へ反映し終えるまで。
 *                        git 終了後の IPC 往復と描画まで覆える
 *   git（setGit）       : そのタブで状態系の git が走っているか。main が自発的に走らせるもの
 *                        （ウィンドウ復帰時の自動更新）は renderer に意図が無いので、こちらでしか拾えない
 *
 * 時間の規則。
 *   遅延    : 落ち着かない期間が delayMs を超えたら出す。数十 ms で終わる更新で帯を点滅させない
 *   即時    : 中身がまだ無いタブは遅延なしで出す。ちらつく相手がおらず、
 *             遅延の間は「空のリポジトリ」と見分けがつかないため
 *   最低表示: 一度出したら minMs は残す。遅延だけだと、遅延をわずかに超えた更新で 1 フレームだけ映る
 *   猶予    : 信号が落ちてから graceMs 以内に再び立ったら、同じ期間の続きとして扱う。
 *             「git 終了 → sessionChanged 到着 → 反映開始」の隙間で遅延を数え直さないため
 *
 * タイマーは落ち着かない期間にしか存在しない。待機時の仕事はゼロ（ポーリングしない）。
 */

export const TAB_ACTIVITY_DELAY_MS = 200;
export const TAB_ACTIVITY_MIN_MS = 500;
export const TAB_ACTIVITY_GRACE_MS = 80;

export interface TabActivityOptions {
  readonly delayMs?: number;
  readonly minMs?: number;
  readonly graceMs?: number;
}

type Timer = ReturnType<typeof setTimeout>;

interface Entry {
  /** 進行中の意図の数。同じタブで操作が重なることがあるので数で持つ。 */
  intents: number;
  /** 状態系の git が走っているか。 */
  git: boolean;
  /** 帯を出した時刻。出していなければ null。 */
  shownAt: number | null;
  /** 遅延が猶予中に満了した。猶予内に再開したら待たずに出す。 */
  due: boolean;
  showTimer: Timer | null;
  settleTimer: Timer | null;
  hideTimer: Timer | null;
}

function isBusy(entry: Entry): boolean {
  return entry.intents > 0 || entry.git;
}

function cancel(timer: Timer | null): null {
  if (timer !== null) clearTimeout(timer);
  return null;
}

export class TabActivity {
  /** 帯を出しているタブ。描画が見るのはこれだけ。 */
  readonly #shown = new SvelteSet<string>();
  readonly #entries = new Map<string, Entry>();
  readonly #delayMs: number;
  readonly #minMs: number;
  readonly #graceMs: number;

  /** 時間を差し替えられるのはテストのため。 */
  constructor(options: TabActivityOptions = {}) {
    this.#delayMs = options.delayMs ?? TAB_ACTIVITY_DELAY_MS;
    this.#minMs = options.minMs ?? TAB_ACTIVITY_MIN_MS;
    this.#graceMs = options.graceMs ?? TAB_ACTIVITY_GRACE_MS;
  }

  /** このタブに帯を出すか。 */
  isShown(id: string): boolean {
    return this.#shown.has(id);
  }

  /**
   * 表示を更新する操作が始まった。
   * @param immediate 中身がまだ無いタブなら true（遅延なしで出す）。
   */
  begin(id: string, immediate = false): void {
    const entry = this.#entry(id);
    entry.intents += 1;
    this.#onBusy(id, entry, immediate);
  }

  /** begin と必ず対にする（finally で呼ぶ）。 */
  end(id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.intents === 0) return;
    entry.intents -= 1;
    if (!isBusy(entry)) this.#onIdle(id, entry);
  }

  /** 状態系の git がこのタブで走っているか。実行中通知が変わるたびに呼ぶ。 */
  setGit(id: string, running: boolean): void {
    const entry = running ? this.#entry(id) : this.#entries.get(id);
    if (entry === undefined || entry.git === running) return;
    entry.git = running;
    if (running) this.#onBusy(id, entry, false);
    else if (!isBusy(entry)) this.#onIdle(id, entry);
  }

  /**
   * タブを閉じた。タイマーごと捨て、帯も即座に消す（最低表示時間を待たない）。
   * 閉じた後に届いた end / setGit は、状態が無いので黙って無視される。
   */
  forget(id: string): void {
    const entry = this.#entries.get(id);
    if (entry !== undefined) {
      entry.showTimer = cancel(entry.showTimer);
      entry.settleTimer = cancel(entry.settleTimer);
      entry.hideTimer = cancel(entry.hideTimer);
      this.#entries.delete(id);
    }
    this.#shown.delete(id);
  }

  #entry(id: string): Entry {
    let entry = this.#entries.get(id);
    if (entry === undefined) {
      entry = {
        intents: 0,
        git: false,
        shownAt: null,
        due: false,
        showTimer: null,
        settleTimer: null,
        hideTimer: null,
      };
      this.#entries.set(id, entry);
    }
    return entry;
  }

  #onBusy(id: string, entry: Entry, immediate: boolean): void {
    // 猶予中・消す予約中なら、それを取り消して同じ期間を続ける
    entry.settleTimer = cancel(entry.settleTimer);
    entry.hideTimer = cancel(entry.hideTimer);
    if (entry.shownAt !== null) return;

    if (immediate || entry.due || this.#delayMs <= 0) {
      entry.showTimer = cancel(entry.showTimer);
      this.#show(id, entry);
      return;
    }
    // 遅延は期間の始まりから数える。既に数えているなら数え直さない
    if (entry.showTimer !== null) return;
    entry.showTimer = setTimeout(() => {
      entry.showTimer = null;
      if (isBusy(entry)) this.#show(id, entry);
      else entry.due = true;
    }, this.#delayMs);
  }

  #onIdle(id: string, entry: Entry): void {
    if (this.#graceMs <= 0) {
      this.#settle(id, entry);
      return;
    }
    entry.settleTimer = cancel(entry.settleTimer);
    entry.settleTimer = setTimeout(() => {
      entry.settleTimer = null;
      this.#settle(id, entry);
    }, this.#graceMs);
  }

  /** 猶予が明けても再開しなかった。期間を閉じる。 */
  #settle(id: string, entry: Entry): void {
    if (isBusy(entry)) return;
    entry.showTimer = cancel(entry.showTimer);
    entry.due = false;
    if (entry.shownAt === null) {
      this.#entries.delete(id);
      return;
    }
    const remaining = this.#minMs - (Date.now() - entry.shownAt);
    if (remaining <= 0) {
      this.#hide(id, entry);
      return;
    }
    entry.hideTimer = setTimeout(() => {
      entry.hideTimer = null;
      this.#hide(id, entry);
    }, remaining);
  }

  #show(id: string, entry: Entry): void {
    entry.shownAt = Date.now();
    this.#shown.add(id);
  }

  /** 呼ばれるのは落ち着いているときだけ（再開すれば #onBusy が消す予約を取り消す）。 */
  #hide(id: string, entry: Entry): void {
    entry.shownAt = null;
    this.#shown.delete(id);
    this.#entries.delete(id);
  }
}
