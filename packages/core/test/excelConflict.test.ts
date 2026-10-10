import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictUnsupportedError,
  DEFAULT_SETTINGS,
  StaleDiffError,
  conflictTargetsOf,
  planXlsxResolution,
  excelToken,
  zlibInflater,
  type ExcelCellChoices,
  type RepositorySession,
  type SessionManager,
} from '../src/index.js';
import { TargetIndex } from '@feathertree/conflict-plan';
import { openWorkbook } from '@feathertree/excel';
import type { BookSpec } from '../../excel/test/xlsxBuilder.js';
import { createExcelRepo, xlsx, type ExcelRepo } from './excelFixture.js';

/*
 * Excel 差分モードのコンフリクト（決定 34）。実 git でマージを衝突させて確かめる。
 *
 * 見るもの:
 *   - CSV は作業ツリーのマーカーから両側を作る（git 0）。違いは衝突した所だけ
 *   - ブックは index の段を #49 で 2 回（自分側・相手側。共通祖先は読まない）。作業ツリーがどちらと同じか
 *   - ファイル単位の採用（ブックは採る側の段を読み直して書く）・セル単位の採用（CSV）
 *   - 書いた後はキャッシュを捨てる。作業ツリーが変わっていれば書かない（diff-stale）
 *   - index には触れない（未マージのまま）
 */

const book = (price: number, note: string): BookSpec => ({
  sheets: [{ name: '売上', rows: [['品名', '単価', '備考'], ['剣', price, note], ['盾', 800, '']] }],
});

const NO_CHOICES: ExcelCellChoices = { cells: [], rows: [], cols: [], rest: null };

describe('Excel のコンフリクト（決定 34）', () => {
  let repo: ExcelRepo;
  let dir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    repo = await createExcelRepo();
    dir = repo.dir;
    manager = repo.sessions(() => DEFAULT_SETTINGS);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const write = (rel: string, content: Uint8Array | string): Promise<void> => repo.write(rel, content);
  const conflict = (rel: string, base: Uint8Array | string, theirs: Uint8Array | string, ours: Uint8Array | string): Promise<void> =>
    repo.conflict(rel, base, theirs, ours);
  const logged = <T>(f: () => Promise<T>): Promise<{ value: T; args: string[] }> => repo.logged(f);

  async function unmerged(session: RepositorySession, path: string): Promise<boolean> {
    await session.refreshStatus();
    return session.snapshot?.entries.find((e) => e.path === path)?.kind === 'unmerged';
  }

  it('CSV はマーカーから両側を作り（git 0）、違いは衝突した所だけ', async () => {
    // 1 行目は自分側だけが変えた（自動マージされる）。最後の行は両側が変えた（衝突）
    await conflict(
      'd.csv',
      ['id,v', '1,a', '2,m', '3,m', '4,m', '5,z', ''].join('\n'),
      ['id,v', '1,a', '2,m', '3,m', '4,m', '5,z-theirs', ''].join('\n'),
      ['id,v', '1,A-ours', '2,m', '3,m', '4,m', '5,z-ours', ''].join('\n'),
    );
    const session = await manager.open(dir);
    const { value: view, args } = await logged(() => session.getExcelComparison('d.csv'));
    expect(args).toEqual(['read-worktree']);
    expect(view.conflict?.source).toBe('markers');
    expect(view.conflict?.blocks).toBe(1);
    expect(view.conflict?.cellResolvable).toBe(true);
    const sheet = view.comparison.sheets[0];
    if (sheet === undefined) throw new Error('no sheet');
    expect(sheet.changedCells).toBe(1);
    expect(sheet.addedRows + sheet.removedRows).toBe(0);
    expect(conflictTargetsOf(view)?.[0]?.cells).toEqual([5, 1]);
  });

  it('CSV をセル単位で採用すると、決めたとおりに継ぎ合わせて書き、index は触らない', async () => {
    await conflict('d.csv', 'id,name,price\n1,a,1\n', 'id,name,price\n1,b,2\n', 'id,name,price\n1,c,3\n');
    const session = await manager.open(dir);
    const view = await session.getExcelComparison('d.csv');
    const sheet = view.comparison.sheets[0];
    if (sheet === undefined) throw new Error('no sheet');
    const row = Array.from(sheet.rowState).findIndex((s) => s !== 0);
    // 名前は相手側、残り（価格）は自分側
    await expect(
      session.resolveExcelConflict(view, { kind: 'cells', choices: NO_CHOICES }),
    ).rejects.toBeInstanceOf(ConflictUnsupportedError);

    const again = await session.getExcelComparison('d.csv');
    await session.resolveExcelConflict(again, {
      kind: 'cells',
      choices: { ...NO_CHOICES, cells: [{ sheet: 0, row, col: 1, side: 'theirs' }], rest: 'ours' },
    });
    expect(await readFile(join(dir, 'd.csv'), 'utf8')).toBe('id,name,price\n1,b,3\n');
    expect(await unmerged(session, 'd.csv')).toBe(true);
  });

  it('CSV のファイル単位の採用はマーカーの外（自動マージ）を保つ', async () => {
    await conflict(
      'd.csv',
      'h\nx\nm\nm\nm\ny\n',
      'h\nX-theirs\nm\nm\nm\ny\n',
      'h\nX-ours\nm\nm\nm\nY-ours\n',
    );
    const session = await manager.open(dir);
    const view = await session.getExcelComparison('d.csv');
    expect(view.conflict?.source).toBe('markers');
    await session.resolveExcelConflict(view, { kind: 'file', side: 'theirs' });
    expect(await readFile(join(dir, 'd.csv'), 'utf8')).toBe('h\nX-theirs\nm\nm\nm\nY-ours\n');
  });

  it('ブックは段を #49 で 2 回読み（共通祖先は読まない）、作業ツリーは自分側と同じと分かる', async () => {
    await conflict('b.xlsx', xlsx(book(1000, 'base')), xlsx(book(1200, 'theirs')), xlsx(book(900, 'ours')));
    const session = await manager.open(dir);
    const { value: view, args } = await logged(() => session.getExcelComparison('b.xlsx'));
    expect(args).toEqual(['read-worktree', 'cat-file', 'cat-file']);
    expect(view.conflict?.source).toBe('stages');
    expect(view.conflict?.worktree).toBe('ours');
    // ブックは段の方式でセル単位に採れる（docs/07）
    expect(view.conflict?.cellResolvable).toBe(true);
    const sheet = view.comparison.sheets[0];
    if (sheet === undefined) throw new Error('no sheet');
    expect(sheet.changedCells).toBe(2);
  });

  it('ブックのファイル単位の採用は採る側の段を読み直して書き、キャッシュを捨てる', async () => {
    const theirs = xlsx(book(1200, 'theirs'));
    await conflict('b.xlsx', xlsx(book(1000, 'base')), theirs, xlsx(book(900, 'ours')));
    const session = await manager.open(dir);
    const view = await session.getExcelComparison('b.xlsx');
    const token = excelToken(view);
    const { args } = await logged(() => session.resolveExcelConflict(view, { kind: 'file', side: 'theirs' }));
    expect(args).toEqual(['read-worktree', 'cat-file', 'write-worktree']);
    expect(Buffer.compare(await readFile(join(dir, 'b.xlsx')), Buffer.from(theirs))).toBe(0);
    expect(session.excelByToken(token)).toBeNull();
    const after = await session.getExcelComparison('b.xlsx');
    expect(after.conflict?.worktree).toBe('theirs');
    expect(await unmerged(session, 'b.xlsx')).toBe(true);
  });

  it('比較を作ってから作業ツリーが変わっていれば書かない（diff-stale）', async () => {
    await conflict('b.xlsx', xlsx(book(1000, 'base')), xlsx(book(1200, 'theirs')), xlsx(book(900, 'ours')));
    const session = await manager.open(dir);
    const view = await session.getExcelComparison('b.xlsx');
    await write('b.xlsx', 'edited by hand');
    await expect(session.resolveExcelConflict(view, { kind: 'file', side: 'theirs' })).rejects.toBeInstanceOf(
      StaleDiffError,
    );
    expect(await readFile(join(dir, 'b.xlsx'), 'utf8')).toBe('edited by hand');
  });

  /** 作業ツリーのブックを開いて、シートの値を 2 次元配列で。 */
  async function gridOf(rel: string): Promise<string[][]> {
    const opened = openWorkbook(await readFile(join(dir, rel)), zlibInflater);
    if (!opened.ok) throw new Error('open ' + opened.reason);
    const book = opened.workbook;
    const data = book.sheets[0]?.data;
    if (data == null) throw new Error('no data');
    const out: string[][] = [];
    for (let r = 0; r <= data.maxRow; r += 1) {
      const row: string[] = [];
      for (let c = 0; c <= data.maxCol; c += 1) {
        const cell = data.rows[r]?.cells.find((x) => x.col === c);
        if (cell === undefined) row.push('');
        else if (cell.formula !== null) row.push('=' + cell.formula);
        else if (cell.kind === 2) row.push(book.sst[cell.num] ?? '');
        else if (cell.kind === 1) row.push(String(cell.num));
        else row.push(cell.text ?? '');
      }
      out.push(row);
    }
    return out;
  }

  it('ブックをセル単位で採用すると、選んだセルだけ相手側になる（index は触らない）', async () => {
    await conflict('b.xlsx', xlsx(book(1000, 'base')), xlsx(book(1200, 'theirs')), xlsx(book(900, 'ours')));
    const session = await manager.open(dir);
    const view = await session.getExcelComparison('b.xlsx');
    expect(view.conflict?.cellResolvable).toBe(true);
    // 単価（B2）は相手側、備考（C2）は自分側
    const { args } = await logged(() =>
      session.resolveExcelConflict(view, {
        kind: 'cells',
        choices: { ...NO_CHOICES, cells: [{ sheet: 0, row: 1, col: 1, side: 'theirs' }], rest: 'ours' },
      }),
    );
    expect(args).toEqual(['read-worktree', 'cat-file', 'cat-file', 'write-worktree']);
    expect(await gridOf('b.xlsx')).toEqual([
      ['品名', '単価', '備考'],
      ['剣', '1200', 'ours'],
      ['盾', '800', ''],
    ]);
    expect(await unmerged(session, 'b.xlsx')).toBe(true);
  });

  it('ブックで相手側にしか無い行を採ると、途中に挿入し、下の行の数式をずらす', async () => {
    const base: BookSpec = { sheets: [{ name: 'S', rows: [['a', 1], ['b', 2], ['合計', { f: 'SUM(B1:B2)', v: 3 }]] }] };
    const theirsBook: BookSpec = { sheets: [{ name: 'S', rows: [['a', 1], ['new', 5], ['b', 2], ['合計', { f: 'SUM(B1:B3)', v: 8 }]] }] };
    const oursBook: BookSpec = { sheets: [{ name: 'S', rows: [['a', 10], ['b', 2], ['合計', { f: 'SUM(B1:B2)', v: 12 }]] }] };
    await conflict('s.xlsx', xlsx(base), xlsx(theirsBook), xlsx(oursBook));
    const session = await manager.open(dir);
    const view = await session.getExcelComparison('s.xlsx');
    await session.resolveExcelConflict(view, { kind: 'cells', choices: { ...NO_CHOICES, rest: 'theirs' } });
    expect(await gridOf('s.xlsx')).toEqual([
      ['a', '1'],
      ['new', '5'],
      ['b', '2'],
      ['合計', '=SUM(B1:B3)'],
    ]);
  });

  it('打った値で決める（CSV は引用符を付け、ブックは数値・文字列で書く）', async () => {
    await conflict('d.csv', 'id,name\n1,a\n', 'id,name\n1,b\n', 'id,name\n1,c\n');
    const session = await manager.open(dir);
    const csvView = await session.getExcelComparison('d.csv');
    await session.resolveExcelConflict(csvView, {
      kind: 'cells',
      choices: { ...NO_CHOICES, edits: [{ sheet: 0, row: 1, col: 1, value: 'b, c' }] },
    });
    expect(await readFile(join(dir, 'd.csv'), 'utf8')).toBe('id,name\n1,"b, c"\n');
  });

  it('ブックのセルに打った値を書く', async () => {
    await conflict('b.xlsx', xlsx(book(1000, 'base')), xlsx(book(1200, 'theirs')), xlsx(book(900, 'ours')));
    const session = await manager.open(dir);
    const view = await session.getExcelComparison('b.xlsx');
    await session.resolveExcelConflict(view, {
      kind: 'cells',
      choices: {
        ...NO_CHOICES,
        rest: 'ours',
        edits: [
          { sheet: 0, row: 1, col: 1, value: '1100' },
          { sheet: 0, row: 1, col: 2, value: '相談して決定' },
        ],
      },
    });
    expect(await gridOf('b.xlsx')).toEqual([
      ['品名', '単価', '備考'],
      ['剣', '1100', '相談して決定'],
      ['盾', '800', ''],
    ]);
  });

  it('CSV: 両側が同じ場所に足した行を、ブロックで両方採用して好きな順に並べる', async () => {
    await conflict(
      'd.csv',
      'id,name\n1,a\n9,z\n',
      'id,name\n1,a\n3,theirs-row\n9,z\n',
      'id,name\n1,a\n2,ours-row\n9,z\n',
    );
    const session = await manager.open(dir);
    const view = await session.getExcelComparison('d.csv');
    const start = Array.from(view.comparison.sheets[0]?.rowState ?? []).findIndex((s) => s !== 0);
    await session.resolveExcelConflict(view, {
      kind: 'cells',
      choices: { ...NO_CHOICES, hunks: [{ sheet: 0, row: start, end: start + 2, order: 'theirs-ours' }] },
    });
    expect(await readFile(join(dir, 'd.csv'), 'utf8')).toBe('id,name\n1,a\n3,theirs-row\n2,ours-row\n9,z\n');
  });

  it('ブック: 両側が足した行を両方採用し、下の行の数式も挿入に合わせてずれる', async () => {
    const base: BookSpec = { sheets: [{ name: 'S', rows: [['a', 1], ['合計', { f: 'SUM(B1:B1)', v: 1 }]] }] };
    const theirsBook: BookSpec = { sheets: [{ name: 'S', rows: [['a', 1], ['T', 20], ['合計', { f: 'SUM(B1:B2)', v: 21 }]] }] };
    const oursBook: BookSpec = { sheets: [{ name: 'S', rows: [['a', 1], ['O', 10], ['合計', { f: 'SUM(B1:B2)', v: 11 }]] }] };
    await conflict('s.xlsx', xlsx(base), xlsx(theirsBook), xlsx(oursBook));
    const session = await manager.open(dir);
    const view = await session.getExcelComparison('s.xlsx');
    const sheet = view.comparison.sheets[0];
    if (sheet === undefined) throw new Error('no sheet');
    // O と T は似ていない（同じ値の列が半分未満）ので片側だけの行 2 つ。合計の行はキャッシュ値が違うので同じブロックに入る。
    // 足された 2 行だけを選んで両方を採用すれば、合計の行は 2 行にならない
    const start = Array.from(sheet.rowState).findIndex((s) => s !== 0);
    await session.resolveExcelConflict(view, {
      kind: 'cells',
      // 合計の行は相手側（相手側の SUM の範囲は T の行を含むので、付け替えると O・T の両方を含む）
      choices: { ...NO_CHOICES, rest: 'theirs', hunks: [{ sheet: 0, row: start, end: start + 2, order: 'ours-theirs' }] },
    });
    expect(await gridOf('s.xlsx')).toEqual([
      ['a', '1'],
      ['O', '10'],
      ['T', '20'],
      ['合計', '=SUM(B1:B3)'],
    ]);
  });

  it('プレビューでの編集: 値の違わないセル・挿入する相手側の行のセルにも打った値を書く', async () => {
    const base: BookSpec = { sheets: [{ name: 'S', rows: [['h', 'v'], ['a', 1], ['z', 9]] }] };
    const theirsBook: BookSpec = { sheets: [{ name: 'S', rows: [['h', 'v'], ['a', 1], ['T', 20], ['z', 9]] }] };
    const oursBook: BookSpec = { sheets: [{ name: 'S', rows: [['h', 'v'], ['a', 1], ['z', 10]] }] };
    await conflict('p.xlsx', xlsx(base), xlsx(theirsBook), xlsx(oursBook));
    const session = await manager.open(dir);
    const view = await session.getExcelComparison('p.xlsx');
    const sheet = view.comparison.sheets[0];
    if (sheet === undefined) throw new Error('no sheet');
    const tRow = Array.from(sheet.oldRow).findIndex((o, i) => o < 0 && (sheet.newRow[i] ?? -1) >= 0);
    await session.resolveExcelConflict(view, {
      kind: 'cells',
      choices: {
        ...NO_CHOICES,
        rest: 'theirs',
        edits: [
          // 見出し（値の違わない行）と、挿入する相手側の行
          { sheet: 0, row: 0, col: 1, value: '値' },
          { sheet: 0, row: tRow, col: 0, value: 'T2' },
        ],
      },
    });
    expect(await gridOf('p.xlsx')).toEqual([
      ['h', '値'],
      ['a', '1'],
      ['T2', '20'],
      ['z', '9'],
    ]);
  });

  it('CSV のプレビューでの編集: 挿入する相手側の行にも打った値を書く', async () => {
    await conflict('e.csv', 'id,v\n1,a\n', 'id,v\n1,a\n2,t\n', 'id,v\n1,b\n');
    const session = await manager.open(dir);
    const view = await session.getExcelComparison('e.csv');
    const sheet = view.comparison.sheets[0];
    if (sheet === undefined) throw new Error('no sheet');
    const tRow = Array.from(sheet.oldRow).findIndex((o, i) => o < 0 && (sheet.newRow[i] ?? -1) >= 0);
    await session.resolveExcelConflict(view, {
      kind: 'cells',
      choices: { ...NO_CHOICES, rest: 'theirs', edits: [{ sheet: 0, row: tRow, col: 1, value: 'x' }] },
    });
    expect(await readFile(join(dir, 'e.csv'), 'utf8')).toBe('id,v\n1,a\n2,x\n');
  });

  it('決めていない違いが残っていれば書かない', async () => {
    await conflict('b.xlsx', xlsx(book(1000, 'base')), xlsx(book(1200, 'theirs')), xlsx(book(900, 'ours')));
    const session = await manager.open(dir);
    const view = await session.getExcelComparison('b.xlsx');
    await expect(session.resolveExcelConflict(view, { kind: 'cells', choices: NO_CHOICES })).rejects.toBeInstanceOf(
      ConflictUnsupportedError,
    );
  });

  it('決めるべき所のある行は、比較の違いのある行と同じ（ブロックの区切りが書き込みとプレビューで揃う）', async () => {
    const base: BookSpec = { sheets: [{ name: 'S', rows: [['h', 'v'], ['a', 1], ['b', 2], ['c', 3], ['z', 9]] }] };
    const theirsBook: BookSpec = { sheets: [{ name: 'S', rows: [['h', 'v'], ['a', 10], ['T', 20], ['b', 2], ['c', 3], ['z', 90]] }] };
    const oursBook: BookSpec = { sheets: [{ name: 'S', rows: [['h', 'v'], ['a', 11], ['b', 2], ['z', 99]] }] };
    await conflict('s.xlsx', xlsx(base), xlsx(theirsBook), xlsx(oursBook));
    const session = await manager.open(dir);
    const view = await session.getExcelComparison('s.xlsx');
    const sheet = view.comparison.sheets[0];
    const targets = conflictTargetsOf(view)?.[0];
    if (sheet === undefined || targets === undefined) throw new Error('no sheet');
    const changed = Array.from(sheet.rowState).flatMap((s, i) => (s === 0 ? [] : [i]));
    expect(changed.length).toBeGreaterThan(2);
    expect(TargetIndex.of(targets).rows).toEqual(changed);
    // 同じ比較からは同じものを返す（作り直さない）
    expect(conflictTargetsOf(view)?.[0]).toBe(targets);
  });

  it('行のずらし方が分からないシートでは、両方を採用を断る', async () => {
    const base: BookSpec = { sheets: [{ name: 'S', rows: [['a', 1], ['z', 9]] }] };
    const theirsBook: BookSpec = { sheets: [{ name: 'S', rows: [['a', 1], ['T', 20], ['z', 9]] }] };
    const oursBook: BookSpec = { sheets: [{ name: 'S', rows: [['a', 1], ['O', 10], ['z', 9]] }] };
    await conflict('s.xlsx', xlsx(base), xlsx(theirsBook), xlsx(oursBook));
    const session = await manager.open(dir);
    const real = await session.getExcelComparison('s.xlsx');
    const conflictInfo = real.conflict;
    const inspection = conflictInfo?.inspection;
    if (conflictInfo == null || inspection == null) throw new Error('no inspection');
    // ピボット等を持つシートの代わりに、行のずらし方が分からない部品があることにする
    const unsafe = new Map([...inspection].map(([k, v]) => [k, { ...v, unsafeRelations: ['pivotTable'] }]));
    const view = { ...real, conflict: { ...conflictInfo, inspection: unsafe } } as typeof real;
    expect(conflictTargetsOf(view)?.[0]?.bothBlocked).toBe('unsafe-part');
    const start = Array.from(real.comparison.sheets[0]?.rowState ?? []).findIndex((s) => s !== 0);
    const plan = planXlsxResolution(view, { ...NO_CHOICES, rest: 'ours', hunks: [{ sheet: 0, row: start, end: start + 2, order: 'ours-theirs' }] });
    expect(plan.blocked).toContain('行のずらし方が分からない');
    expect(planXlsxResolution(view, { ...NO_CHOICES, rest: 'ours' }).blocked).toBeNull();
  });
});
