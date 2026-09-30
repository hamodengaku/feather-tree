/*
 * Excel のシリアル値 ↔ 日時（決定 33 の M3）。
 *
 * - 1900 年起点（既定）: 1 = 1900-01-01。**60 = 1900-02-29**（実在しない日。Lotus 1-2-3 との互換のため
 *   Excel は 1900 年を閏年として数える）。61 以降は 1 日ずれて 61 = 1900-03-01
 * - 1904 年起点（Mac の旧 Excel。workbookPr date1904="1"）: 0 = 1904-01-01
 *
 * 時刻は小数部（1 日 = 1.0）。計算はすべて UTC で行い、タイムゾーンに左右されない。
 */

export interface DateParts {
  readonly year: number;
  readonly month: number; // 1〜12
  readonly day: number; // 1〜31
  /** 曜日（0 = 日曜）。 */
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 秒の端数（0 以上 1 未満）。 */
  readonly fraction: number;
}

const DAY_MS = 86_400_000;
/** 1899-12-31（1900 年起点のシリアル 0）。 */
const EPOCH_1900 = Date.UTC(1899, 11, 31);
/** 1899-12-30（61 以降はここを 0 とみなすと、存在しない 2/29 のずれが消える）。 */
const EPOCH_1900_AFTER_LEAP = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/** Excel が扱える最大のシリアル（9999-12-31）。これを超える・負の値は日付として出さない。 */
export const MAX_SERIAL = 2_958_465;

/**
 * シリアル値を日時に。`secondDigits` は秒の小数の桁数（丸めの位置。0 なら秒に丸める）。
 * 範囲外なら null。
 */
export function serialToParts(serial: number, date1904: boolean, secondDigits = 0): DateParts | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > MAX_SERIAL + 1) return null;
  let days = Math.floor(serial);
  // 時刻は丸めの位置で繰り上げる（23:59:59.6 は、秒に丸めると翌日の 0:00:00）
  const unit = 10 ** Math.max(0, Math.min(3, secondDigits));
  let ticks = Math.round((serial - days) * 86_400 * unit);
  if (ticks >= 86_400 * unit) {
    days += 1;
    ticks -= 86_400 * unit;
  }
  const totalSeconds = Math.floor(ticks / unit);
  const fraction = (ticks % unit) / unit;
  const hour = Math.floor(totalSeconds / 3600);
  const minute = Math.floor((totalSeconds % 3600) / 60);
  const second = totalSeconds % 60;

  if (!date1904 && days === 60) {
    // 1900-02-29（Excel の閏年の誤り）。曜日は Excel の数え方（1900-01-01 を日曜）に合わせて 3（水曜）
    return { year: 1900, month: 2, day: 29, weekday: 3, hour, minute, second, fraction };
  }
  let ms: number;
  if (date1904) ms = EPOCH_1904 + days * DAY_MS;
  else if (days < 60) ms = EPOCH_1900 + days * DAY_MS;
  else ms = EPOCH_1900_AFTER_LEAP + days * DAY_MS;
  const d = new Date(ms);
  // 1900-03-01 より前は Excel の曜日が 1 日ずれている（1900-01-01 を日曜として数える）
  const weekday = !date1904 && days < 60 ? (d.getUTCDay() + 6) % 7 : d.getUTCDay();
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday,
    hour,
    minute,
    second,
    fraction,
  };
}

/** ISO 8601 の日時（t="d" のセル）をシリアル値に。読めなければ null。 */
export function isoToSerial(text: string, date1904: boolean): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?/.exec(text.trim());
  if (m === null) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  if (!Number.isFinite(ms)) return null;
  const frac = m[7] === undefined ? 0 : Number(m[7]);
  if (date1904) return (ms - EPOCH_1904) / DAY_MS + frac / 86_400;
  const days = (ms - EPOCH_1900_AFTER_LEAP) / DAY_MS;
  // 1900-03-01 より前は、存在しない 2/29 のぶん 1 つ小さい
  return (days < 61 ? days - 1 : days) + frac / 86_400;
}

/** 和暦の元号。開始日（その日から）で引く。 */
interface Era {
  readonly start: number; // yyyymmdd
  readonly name: string;
  readonly short: string;
  readonly letter: string;
}

const ERAS: readonly Era[] = [
  { start: 20190501, name: '令和', short: '令', letter: 'R' },
  { start: 19890108, name: '平成', short: '平', letter: 'H' },
  { start: 19261225, name: '昭和', short: '昭', letter: 'S' },
  { start: 19120730, name: '大正', short: '大', letter: 'T' },
  { start: 18680101, name: '明治', short: '明', letter: 'M' },
];

export interface EraYear {
  readonly era: Era;
  /** 元号の年（元年 = 1）。 */
  readonly year: number;
}

/** 和暦。明治より前は null（西暦で出す）。 */
export function eraOf(parts: DateParts): EraYear | null {
  const key = parts.year * 10_000 + parts.month * 100 + parts.day;
  for (const era of ERAS) {
    if (key >= era.start) return { era, year: parts.year - Math.floor(era.start / 10_000) + 1 };
  }
  return null;
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** 日本語の曜日（aaa / aaaa）。 */
export const DAY_NAMES_JA = ['日', '月', '火', '水', '木', '金', '土'];
