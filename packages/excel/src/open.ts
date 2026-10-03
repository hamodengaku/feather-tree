/*
 * 拡張子で開き方を選ぶ（ブックは ZIP として、CSV はテキストとして）。
 * 呼び出し側（core）が拡張子で分岐しなくて済むよう、入口を 1 つにしておく。
 */

import { openCsvSteps } from './csv/csv.js';
import { DEFAULT_LIMITS, type ExcelLimits } from './limits.js';
import type { OpenResult } from './model/types.js';
import { openWorkbookSteps } from './workbook/workbook.js';
import type { Inflater } from './zip/reader.js';

export function isCsvPath(path: string): boolean {
  return path.toLowerCase().endsWith('.csv');
}

export function openSpreadsheetSteps(
  path: string,
  bytes: Uint8Array,
  inflate: Inflater,
  limits: ExcelLimits = DEFAULT_LIMITS,
): Generator<void, OpenResult> {
  return isCsvPath(path) ? openCsvSteps(bytes, limits) : openWorkbookSteps(bytes, inflate, limits);
}
