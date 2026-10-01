/**
 * 差分ペインのスクロール位置の扱い（2026-10-01、利用者の指示）。
 *
 * **リセットするのは「別のファイルを表示したとき」だけ。** 同じファイルの読み直し
 * （hunk ステージ・更新ボタン・ウィンドウ復帰時の更新・他の書き込み操作の後）、
 * タブの往復、モードの往復では位置を保つ。
 *
 * 位置は「枠（slot）」ごとに直近 1 ファイル分だけ覚える。枠はペインの種類とタブで分ける
 * （例 `diff:<タブ id>`）。タブ A で見ていたファイルに戻ってきたら、その位置へ戻す。
 * ペインがモード切替で作り直されても、覚えはこのモジュールに残る。
 */

export interface ScrollPosition {
  readonly top: number;
  readonly left: number;
}

interface Remembered extends ScrollPosition {
  readonly key: string;
}

/** 枠の数の上限。タブを開け閉めしても際限なく増えないようにする。 */
const MAX_SLOTS = 100;

export class ScrollMemory {
  readonly #slots = new Map<string, Remembered>();

  /**
   * そのファイルを表示し始めたときに、どこへスクロールすべきか。
   * 枠が覚えているのと同じファイルなら覚えていた位置、違えば先頭（そして覚え直す）。
   */
  positionFor(slot: string, key: string): ScrollPosition {
    const saved = this.#slots.get(slot);
    if (saved !== undefined && saved.key === key) return { top: saved.top, left: saved.left };
    this.record(slot, key, { top: 0, left: 0 });
    return { top: 0, left: 0 };
  }

  record(slot: string, key: string, position: ScrollPosition): void {
    this.#slots.delete(slot);
    this.#slots.set(slot, { key, top: position.top, left: position.left });
    if (this.#slots.size > MAX_SLOTS) {
      const oldest = this.#slots.keys().next().value;
      if (oldest !== undefined) this.#slots.delete(oldest);
    }
  }
}

const memory = new ScrollMemory();

export interface RememberScrollParams {
  /** 覚える枠。ペインの種類 + タブ id。 */
  readonly slot: string;
  /** 表示中のファイルの同一性。空文字は「何も表示していない」。 */
  readonly key: string;
  /**
   * 中身が描画されているか。読み込み中（「読み込み中…」に差し替わっている間）は偽にする。
   * 差し替えで中身が縮むとブラウザが位置を 0 に詰め、その scroll イベントを覚えてしまうため。
   */
  readonly ready: boolean;
}

/**
 * スクロールする要素に付ける action。
 *
 * - 中身が描画された瞬間（ready が偽→真、または枠・ファイルが変わった）にだけ位置を決める
 * - 同じファイルのまま中身が差し替わった（ready が真のまま）ときは何もしない＝ブラウザが位置を保つ
 * - 利用者のスクロールは ready の間だけ覚える
 */
export function rememberScroll(node: HTMLElement, initial: RememberScrollParams) {
  let params = initial;
  let applied: { slot: string; key: string } | null = null;

  const apply = (): void => {
    if (!params.ready || params.key === '') {
      applied = null;
      return;
    }
    if (applied !== null && applied.slot === params.slot && applied.key === params.key) return;
    applied = { slot: params.slot, key: params.key };
    const target = memory.positionFor(params.slot, params.key);
    // 中身の描画が済んでから当てる（先に当てると高さが足りず 0 に詰められる）
    requestAnimationFrame(() => {
      node.scrollTop = target.top;
      node.scrollLeft = target.left;
    });
  };

  const onScroll = (): void => {
    if (!params.ready || params.key === '' || applied === null) return;
    memory.record(params.slot, params.key, { top: node.scrollTop, left: node.scrollLeft });
  };

  node.addEventListener('scroll', onScroll, { passive: true });
  apply();

  return {
    update(next: RememberScrollParams): void {
      params = next;
      apply();
    },
    destroy(): void {
      node.removeEventListener('scroll', onScroll);
    },
  };
}
