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

/** ネストしたオブジェクトを安全に取り出す。 */
export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
