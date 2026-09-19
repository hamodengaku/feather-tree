/**
 * 設定ファイルの値を安全に読むためのヘルパ。
 *
 * 設定ファイルは人間が手で編集しうるし、古いバージョンの残骸も入る。
 * **未知・不正な値は既定値で埋めて必ず有効な設定を返す**（起動を止めない）のが土台の方針。
 */

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 0..1 の比率などの実数値。値が無い／不正なら null（「まだ移行していない」の意味に使う）。 */
export function clampFloatOrNull(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

export function stringArray(value: unknown, limit: number): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, limit);
}

/** 許可された値のどれかならそれを、違えば既定値を返す。 */
export function pickFrom<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * epoch ms のような「0 以上の整数か null」を保つ値。
 * 既定は null（「まだ確認していない」等の意味に使う。clampInt と違い、範囲外を
 * 既定値へ丸めるのではなく null に落とす——最終確認時刻は丸めて誤魔化せる値ではないため）。
 */
export function intOrNull(value: unknown, min: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded < min ? null : rounded;
}

/** ネストしたオブジェクトを安全に取り出す。 */
export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * 「キー → 文字列配列」の辞書。リポジトリごとの UI 状態のように、
 * 件数が際限なく増えうるものを保存するのに使う。
 *
 * 上限を超えた分は先頭から `keyLimit` 件だけ残す。呼び出し側が
 * 「今使っているキーを先頭に置いて渡す」ことで、使用中の項目が落ちないようにできる。
 */
export function stringArrayRecord(
  value: unknown,
  keyLimit: number,
  itemLimit: number,
): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = {};
  let kept = 0;
  for (const [key, raw] of Object.entries(record(value))) {
    if (kept >= keyLimit) break;
    if (key.length === 0 || !Array.isArray(raw)) continue;
    const items = stringArray(raw, itemLimit);
    // 空配列は「既定と同じ」なので保存しない（設定ファイルが無駄に育つのを防ぐ）
    if (items.length === 0) continue;
    out[key] = items;
    kept += 1;
  }
  return out;
}
