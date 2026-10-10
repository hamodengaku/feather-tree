/*
 * Excel 差分モードのコンフリクトの右クリックのメニュー（docs/07 7.1・7.2）。**純関数だけ。**
 *
 * 何を出すか（文言・押せるか・押したら何をするか）だけを決める。押したときの処理は ExcelPane が命令ごとに持つ。
 *
 *   - 自分側 / 相手側を採用（1 セルなら両側の値を、片側だけの行なら行がどうなるかを添える）
 *   - 選んだ行で両方を採用（自分側 → 相手側 / 相手側 → 自分側）
 *   - 個別の指定を外す・未決定の残りをすべて自分側 / 相手側
 *   - セルを編集…（1 セルだけ選んでいるとき）
 *
 * 相手側を採れない所（docs/07 3.2）を含めば、相手側・両方・編集は理由を添えて押せなくする。両方を採用は、
 * シートが両方を採用できない（行の挿入になる）ときも押せない。
 */

import type { BlockReason, BothOrder, ConflictSide } from '@feathertree/conflict-plan';
import { blockReasonText } from './excelText.js';

export type ConflictMenuCommand =
  | { readonly kind: 'side'; readonly side: ConflictSide }
  | { readonly kind: 'both'; readonly order: BothOrder }
  | { readonly kind: 'clear' }
  | { readonly kind: 'rest'; readonly side: ConflictSide }
  | { readonly kind: 'edit' };

export interface ConflictMenuItem {
  readonly label: string;
  readonly disabled: boolean;
  /** 押したときの命令。null は押せない案内だけの行。 */
  readonly command: ConflictMenuCommand | null;
}

export interface ConflictMenuInput {
  /** 選んだ範囲の決めるべき所。 */
  readonly cells: readonly { readonly row: number; readonly col: number }[];
  readonly rows: readonly number[];
  /** 範囲が掛かる両方を採用の単位の数。 */
  readonly bothSpans: number;
  /** 範囲の中で相手側を採れない理由（最初の 1 つ）。 */
  readonly blocked: BlockReason | null;
  /** シートが両方を採用できない理由。 */
  readonly bothBlocked: BlockReason | null;
  /** 1 セルだけのとき、その両側の表示。 */
  readonly cellText: { readonly ours: string; readonly theirs: string } | null;
  /** 片側だけの行 1 つだけのとき、その行が自分側にあるか。 */
  readonly rowInOurs: boolean | null;
  /** 1 セルだけ選んでいて編集できるか。 */
  readonly editable: boolean;
}

/** メニューに添える値（長ければ切る。改行は空白に）。 */
export function clip(text: string): string {
  let flat = '';
  for (const ch of text) flat += ch === '\n' || ch === '\r' ? ' ' : ch;
  if (flat === '') return '（空）';
  return flat.length > 24 ? flat.slice(0, 24) + '…' : flat;
}

const withReason = (label: string, reason: BlockReason | null): string => (reason === null ? label : label + ' — ' + blockReasonText(reason));

export function buildConflictMenu(input: ConflictMenuInput): ConflictMenuItem[] {
  const count = input.cells.length + input.rows.length;
  if (count === 0) return [{ label: 'この範囲にコンフリクトはありません', disabled: true, command: null }];
  const blocked = input.blocked;

  let ours: string;
  let theirs: string;
  if (count === 1 && input.cellText !== null) {
    ours = '自分側を採用「' + clip(input.cellText.ours) + '」';
    theirs = '相手側を採用「' + clip(input.cellText.theirs) + '」';
  } else if (count === 1 && input.rowInOurs !== null) {
    ours = input.rowInOurs ? '自分側を採用（この行を残す）' : '自分側を採用（この行を入れない）';
    theirs = input.rowInOurs ? '相手側を採用（この行を削除する）' : '相手側を採用（この行を挿入する）';
  } else {
    ours = '自分側を採用（' + String(count) + ' か所）';
    theirs = '相手側を採用（' + String(count) + ' か所）';
  }

  const items: ConflictMenuItem[] = [
    { label: ours, disabled: false, command: { kind: 'side', side: 'ours' } },
    { label: withReason(theirs, blocked), disabled: blocked !== null, command: { kind: 'side', side: 'theirs' } },
  ];
  // 両方を採用は相手側の行を挿入することになる。採れない所を含む・シートが挿入を扱えないなら押せない
  if (input.bothSpans > 0) {
    const reason = blocked ?? input.bothBlocked;
    for (const order of ['ours-theirs', 'theirs-ours'] as const) {
      const arrow = order === 'ours-theirs' ? '自分側 → 相手側' : '相手側 → 自分側';
      items.push({ label: withReason(`選んだ行で両方を採用（${arrow}）`, reason), disabled: reason !== null, command: { kind: 'both', order } });
    }
  }
  items.push(
    { label: '個別の指定を外す', disabled: false, command: { kind: 'clear' } },
    // 残りすべて（帯から移した。docs/07 7.0）。ブック全体で、個別に決めていない所に効く
    { label: '未決定の残りをすべて自分側を採用', disabled: false, command: { kind: 'rest', side: 'ours' } },
    { label: '未決定の残りをすべて相手側を採用', disabled: false, command: { kind: 'rest', side: 'theirs' } },
  );
  if (input.editable) {
    items.push({ label: withReason('セルを編集…', blocked), disabled: blocked !== null, command: { kind: 'edit' } });
  }
  return items;
}
