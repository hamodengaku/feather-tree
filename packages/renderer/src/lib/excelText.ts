/*
 * Excel 差分モード（決定 33）の案内の文言。**純関数だけ。**
 *
 * どの状態でも「何が起きていて、利用者は何をすればよいか」を 1 文で出す（要件 E7）。
 * 白い画面に落とさない。
 */

import type { ExcelConflictDto, ExcelSheetSummaryDto, ExcelSideDto, ExcelSideStateDto } from '@feathertree/ipc';

export type ExcelSideName = 'old' | 'new';

/** 側ごとの状態の案内。ok なら null。 */
export function sideNotice(side: ExcelSideName, state: ExcelSideStateDto): string | null {
  switch (state) {
    case 'ok':
      return null;
    case 'absent':
      return side === 'old' ? 'HEAD にはありません（新しく追加したファイルです）。' : '作業ツリーにありません（削除されています）。';
    case 'lfs-pointer':
      return side === 'old'
        ? 'HEAD 側が Git LFS のポインタのままです。Git LFS が導入されていない（git lfs install 前の）可能性があります。'
        : 'Git LFS のポインタのままです。git lfs pull で実体を取得してから「更新」を押してください。';
    case 'lfs-failed':
      return 'Git LFS の実体を取り出せませんでした。Git LFS が導入されているか、ネットワークに接続できるかを確認してください。';
    case 'unavailable':
      return 'HEAD 側を取り出せませんでした（時間切れなど）。「更新」でやり直せます。';
    case 'encrypted-or-legacy':
      return 'パスワード付き、または旧形式（.xls）のため表示できません。';
    case 'not-spreadsheet':
      return 'Excel のブック・CSV として読めません（.xlsb とバイナリのファイルは対象外です）。';
    case 'too-large':
      return '大きすぎるため表示できません（上限 100MB）。';
    case 'locked':
      return '他のアプリが使用中のため読めません。閉じてから「更新」を押してください。';
    case 'empty':
      return '空のファイルです。';
    case 'not-zip':
    case 'broken':
      return 'ファイルが壊れているため読めません。';
    default:
      return '表示できません。';
  }
}

/** 側の見出し（値バー・グリッドの上）。未マージなら自分側 ｜ 相手側（決定 34）。 */
export function sideLabel(side: ExcelSideName, conflict = false): string {
  if (conflict) return side === 'old' ? '自分側（ours・現在のブランチ）' : '相手側（theirs・取り込む側）';
  return side === 'old' ? '旧版（HEAD）' : '新版（作業ツリー）';
}

/** 未マージのときの、側ごとの案内（決定 34）。sideNotice より先に見る。言うことが無ければ null。 */
export function conflictSideNotice(side: ExcelSideName, state: ExcelSideStateDto): string | null {
  if (state !== 'absent') return null;
  return side === 'old' ? '自分側ではこのファイルは削除されています。' : '相手側ではこのファイルは削除されています。';
}

/** コンフリクトの帯の 1 行目（決定 34）。何が起きていて、次に何をすればよいか。 */
export function conflictSummary(conflict: ExcelConflictDto): string {
  if (conflict.source === 'markers') {
    return `コンフリクト ${String(conflict.blocks)} 件（作業ツリーのマーカーから）。違いとして出ているのは衝突した所だけです。`;
  }
  const parts: string[] = [];
  switch (conflict.markers) {
    case 'none':
      parts.push('作業ツリーにマーカーがありません（解消済み、またはマーカーを書かない形式です）。');
      break;
    case 'malformed':
      parts.push('マーカーの対応が取れていないため、index の自分側・相手側を比べています。');
      break;
    case 'unsupported':
      parts.push('UTF-16 の CSV はマーカーを読めないため、index の自分側・相手側を比べています。');
      break;
    default:
      parts.push('コンフリクト中です（index の自分側・相手側を比べています）。');
  }
  parts.push(worktreeMatchText(conflict.worktree));
  return parts.join('');
}

function worktreeMatchText(match: ExcelConflictDto['worktree']): string {
  switch (match) {
    case 'ours':
      return '作業ツリーは自分側と同じ内容です。';
    case 'theirs':
      return '作業ツリーは相手側と同じ内容です。';
    case 'absent':
      return '作業ツリーにはファイルがありません。';
    case 'unknown':
      return '作業ツリーのファイルを読めませんでした。';
    default:
      return '作業ツリーはどちらの側とも違います（手で編集されています）。';
  }
}

/**
 * シートの、その側での案内。表示できるなら null。
 * ブック自体が読めない側は sideNotice が先に出るので、ここでは扱わない。
 */
export function sheetNotice(side: ExcelSideName, sheet: ExcelSheetSummaryDto): string | null {
  const name = side === 'old' ? sheet.oldName : sheet.newName;
  if (name === null) return side === 'old' ? 'このシートは旧版にありません（追加されたシートです）。' : 'このシートは新版にありません（削除されたシートです）。';
  if (sheet.kind === 'chartsheet') return 'グラフシートは表示できません。';
  if (sheet.kind === 'other') return 'このシートの種類は表示できません。';
  const problem = side === 'old' ? sheet.oldProblem : sheet.newProblem;
  if (problem === 'missing-part' || problem === 'broken' || problem === 'unsupported') {
    return 'このシートは読めませんでした。';
  }
  return null;
}

/** シートの帯（グリッドの上に 1 行）に出す注意。無ければ空。 */
export function sheetWarnings(sheet: ExcelSheetSummaryDto): string[] {
  const out: string[] = [];
  if (sheet.oldProblem === 'too-large' || sheet.newProblem === 'too-large') {
    out.push('セルが多すぎるため、途中までしか読んでいません。');
  }
  if (sheet.columnsTruncated) out.push('列が多すぎるため、右側の列を読んでいません。');
  if (sheet.positional) {
    out.push('変更が多すぎるため、一部の行は位置で対応付けています（行の挿入・削除を見分けられていません）。');
  }
  return out;
}

/** シートタブのラベル。名前が変わっていれば「旧 → 新」。 */
export function sheetLabel(sheet: ExcelSheetSummaryDto): string {
  if (sheet.renamed && sheet.oldName !== null && sheet.newName !== null) return sheet.oldName + ' → ' + sheet.newName;
  return sheet.newName ?? sheet.oldName ?? '';
}

/** シートタブの印（+ 追加 / − 削除 / ● 変更）。 */
export function sheetMarkSymbol(sheet: ExcelSheetSummaryDto): string {
  switch (sheet.mark) {
    case 'added':
      return '+';
    case 'removed':
      return '−';
    case 'changed':
      return '●';
    default:
      return '';
  }
}

/** 未マージのときのブック全体の一言（決定 34）。 */
export function conflictWorkbookSummary(sheets: readonly ExcelSheetSummaryDto[]): string {
  const changed = sheets.filter((s) => s.mark !== 'same' || s.renamed).length;
  if (changed === 0) return '両側の値に違いはありません';
  return `${String(changed)} シートに違い`;
}

/** ブック全体の一言（差分ペインの見出し・Excel ペインの帯）。 */
export function workbookSummary(
  sheets: readonly ExcelSheetSummaryDto[],
  old: ExcelSideDto,
  now: ExcelSideDto,
): string {
  if (old.state === 'absent') return '新しく追加したブック';
  if (now.state === 'absent') return '削除したブック';
  const changed = sheets.filter((s) => s.mark !== 'same' || s.renamed).length;
  if (changed === 0) return '値の変更はありません';
  return `${String(changed)} シートに変更`;
}
