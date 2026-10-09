/*
 * マージ後のプレビュー（docs/07-xlsx-cell-merge.md 7.3）の行の並び。**純関数だけ。**
 *
 * 書き込みの行の並び（main の planXlsxResolution / planCsvResolution）と同じ規則で、今の採り方から
 * 「書き込むとどの揃えた行のどちらの側が、どの順に並ぶか」を作る。値は左右のグリッドが読んだ行から引く。
 *
 *   - 違いの無い行: そのまま（自分側）
 *   - 両方を採用の範囲: 範囲の自分側の行を全部、続けて相手側の行を全部（または逆）
 *   - 両側にある値の違う行: 行で両方を採用なら 2 行、それ以外はセルごとに採った側（mixed）
 *   - 片側にしか無い行: その行がある側を採れば出し、無い側を採れば出さない。未決定なら印を付けて出す
 */

import type { ExcelSheetLayoutDto, ExcelSheetSummaryDto } from '@feathertree/ipc';
import {
  choiceForRow,
  hunkEndOf,
  hunkStartOf,
  isBothOrder,
  isOneSidedRow,
  lineKey,
  type BothOrder,
  type ConflictChoiceState,
} from './excelConflict.js';

export interface PreviewRow {
  /** 値を引く揃えた行。 */
  readonly aligned: number;
  /** 行全体を出す側（mixed のときは自分側を土台に、セルごとに採った側を引く）。 */
  readonly side: 'ours' | 'theirs';
  /** 両側にある値の違う行で、セルごとに採り方が決まる。 */
  readonly mixed: boolean;
  /** 片側にしか無い行で、まだ決めていない。 */
  readonly undecided: boolean;
}

function pushBoth(out: PreviewRow[], layout: ExcelSheetLayoutDto, from: number, to: number, order: BothOrder): void {
  const ours: PreviewRow[] = [];
  const theirs: PreviewRow[] = [];
  for (let i = from; i < to; i += 1) {
    if ((layout.oldRow[i] ?? -1) >= 0) ours.push({ aligned: i, side: 'ours', mixed: false, undecided: false });
    if ((layout.newRow[i] ?? -1) >= 0) theirs.push({ aligned: i, side: 'theirs', mixed: false, undecided: false });
  }
  out.push(...(order === 'ours-theirs' ? [...ours, ...theirs] : [...theirs, ...ours]));
}

export function buildPreviewRows(
  layout: ExcelSheetLayoutDto,
  summary: ExcelSheetSummaryDto | undefined,
  state: ConflictChoiceState,
  sheet: number,
): PreviewRow[] {
  const out: PreviewRow[] = [];
  for (let i = 0; i < layout.rowCount; i += 1) {
    const o = layout.oldRow[i] ?? -1;
    const start = hunkStartOf(summary, i);
    if (start < 0 || summary === undefined) {
      out.push({ aligned: i, side: o >= 0 ? 'ours' : 'theirs', mixed: false, undecided: false });
      continue;
    }
    // 両方を採用の範囲（ブロックの中に切り詰める。書き込みと同じ）
    const block = state.hunks.get(lineKey(sheet, i));
    if (block !== undefined) {
      const end = Math.max(i + 1, Math.min(block.end, hunkEndOf(summary, start)));
      pushBoth(out, layout, i, end, block.order);
      i = end - 1;
      continue;
    }
    if (!isOneSidedRow(summary, i)) {
      const rowChoice = state.rows.get(lineKey(sheet, i));
      if (isBothOrder(rowChoice)) pushBoth(out, layout, i, i + 1, rowChoice);
      else out.push({ aligned: i, side: 'ours', mixed: true, undecided: false });
      continue;
    }
    const present = o >= 0 ? 'ours' : 'theirs';
    const choice = choiceForRow(state, sheet, i, summary);
    if (choice === null) out.push({ aligned: i, side: present, mixed: false, undecided: true });
    else if (choice === present || isBothOrder(choice)) out.push({ aligned: i, side: present, mixed: false, undecided: false });
  }
  return out;
}

/** 揃えた行 → プレビューで最初に出る位置（出ない行は無し）。上のグリッドの選択に合わせて移るのに使う。 */
export function previewIndexOf(rows: readonly PreviewRow[]): Map<number, number> {
  const out = new Map<number, number>();
  rows.forEach((r, k) => {
    if (!out.has(r.aligned)) out.set(r.aligned, k);
  });
  return out;
}

/** 採り方が 1 つでも決まっているか（プレビューを出す条件）。 */
export function hasAnyChoice(state: ConflictChoiceState): boolean {
  return (
    state.rest !== null ||
    state.cells.size > 0 ||
    state.rows.size > 0 ||
    state.cols.size > 0 ||
    state.edits.size > 0 ||
    state.hunks.size > 0
  );
}
