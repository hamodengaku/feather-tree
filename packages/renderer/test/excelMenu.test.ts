import { describe, expect, it } from 'vitest';
import { buildConflictMenu, clip, type ConflictMenuInput } from '../src/lib/excelMenu.js';

/*
 * Excel 差分モードのコンフリクトの右クリックのメニュー（docs/07 7.1・7.2）。文言・押せるか・命令だけを見る。
 */

const BASE: ConflictMenuInput = {
  cells: [{ row: 1, col: 1 }],
  rows: [],
  bothSpans: 1,
  blocked: null,
  bothBlocked: null,
  cellText: { ours: '900', theirs: '1200' },
  rowInOurs: null,
  editable: true,
};

const labels = (input: ConflictMenuInput): string[] => buildConflictMenu(input).map((i) => i.label);

describe('コンフリクトの右クリックのメニュー', () => {
  it('1 セルなら両側の値を添え、両方を採用・外す・残りすべて・編集を出す', () => {
    expect(labels(BASE)).toEqual([
      '自分側を採用「900」',
      '相手側を採用「1200」',
      '選んだ行で両方を採用（自分側 → 相手側）',
      '選んだ行で両方を採用（相手側 → 自分側）',
      '個別の指定を外す',
      '未決定の残りをすべて自分側を採用',
      '未決定の残りをすべて相手側を採用',
      'セルを編集…',
    ]);
    expect(buildConflictMenu(BASE).map((i) => i.command)).toEqual([
      { kind: 'side', side: 'ours' },
      { kind: 'side', side: 'theirs' },
      { kind: 'both', order: 'ours-theirs' },
      { kind: 'both', order: 'theirs-ours' },
      { kind: 'clear' },
      { kind: 'rest', side: 'ours' },
      { kind: 'rest', side: 'theirs' },
      { kind: 'edit' },
    ]);
  });

  it('片側だけの行 1 つなら、行がどうなるかを添える', () => {
    const row = { ...BASE, cells: [], rows: [3], cellText: null, editable: false };
    expect(labels({ ...row, rowInOurs: true }).slice(0, 2)).toEqual(['自分側を採用（この行を残す）', '相手側を採用（この行を削除する）']);
    expect(labels({ ...row, rowInOurs: false }).slice(0, 2)).toEqual(['自分側を採用（この行を入れない）', '相手側を採用（この行を挿入する）']);
  });

  it('複数なら数を添え、両方を採用の単位が無ければ両方を出さない', () => {
    const many = labels({ ...BASE, cells: [{ row: 1, col: 1 }, { row: 1, col: 2 }], rows: [3], cellText: null, bothSpans: 0, editable: false });
    expect(many.slice(0, 2)).toEqual(['自分側を採用（3 か所）', '相手側を採用（3 か所）']);
    expect(many.some((l) => l.includes('両方'))).toBe(false);
  });

  it('相手側を採れない所を含めば、theirs・両方・編集を理由付きで押せなくする', () => {
    const items = buildConflictMenu({ ...BASE, blocked: 'table-header' });
    const disabled = items.filter((i) => i.disabled).map((i) => i.command?.kind);
    expect(disabled).toEqual(['side', 'both', 'both', 'edit']);
    expect(items[1]?.label).toContain(' — ');
  });

  it('シートが両方を採用できなければ、両方だけを押せなくする', () => {
    const items = buildConflictMenu({ ...BASE, bothBlocked: 'unsafe-part' });
    expect(items.filter((i) => i.disabled).map((i) => i.command)).toEqual([
      { kind: 'both', order: 'ours-theirs' },
      { kind: 'both', order: 'theirs-ours' },
    ]);
  });

  it('範囲に決めるべき所が無ければ、案内だけ', () => {
    expect(buildConflictMenu({ ...BASE, cells: [], rows: [] })).toEqual([
      { label: 'この範囲にコンフリクトはありません', disabled: true, command: null },
    ]);
  });

  it('添える値は改行を空白にし、長ければ切る。空なら（空）', () => {
    expect(clip('a\nb')).toBe('a b');
    expect(clip('x'.repeat(30))).toBe('x'.repeat(24) + '…');
    expect(clip('')).toBe('（空）');
  });
});
