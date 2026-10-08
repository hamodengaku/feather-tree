import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandLog,
  ConflictUnsupportedError,
  DEFAULT_SETTINGS,
  SessionManager,
  StaleDiffError,
  baseCellOf,
  conflictTargetsOf,
  excelToken,
  zlibInflater,
  type ExcelCellChoices,
  type RepositorySession,
} from '../src/index.js';
import { openWorkbook } from '@feathertree/excel';
import { buildXlsx, type BookSpec } from '../../excel/test/xlsxBuilder.js';

/*
 * Excel 差分モードのコンフリクト（決定 34）。実 git でマージを衝突させて確かめる。
 *
 * 見るもの:
 *   - CSV は作業ツリーのマーカーから両側を作る（git 0）。違いは衝突した所だけ
 *   - ブックは index の段を #49 で 3 回（自分側・相手側・共通祖先）。作業ツリーがどちらと同じか
 *   - ファイル単位の採用（ブックは採る側の段を読み直して書く）・セル単位の採用（CSV）
 *   - 書いた後はキャッシュを捨てる。作業ツリーが変わっていれば書かない（diff-stale）
 *   - index には触れない（未マージのまま）
 */

const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/core-excel-conflict-tests');
const GIT_PATH = process.env['FT_TEST_GIT'] ?? 'git';

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(GIT_PATH, [...args], { cwd, shell: false, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', rej);
    child.on('close', (code) =>
      code === 0 ? res(out) : rej(new Error('git failed: ' + String(code) + ' ' + args.join(' ') + ' ' + err)),
    );
  });
}

const deflate = (d: Uint8Array): Uint8Array => deflateRawSync(d);
const xlsx = (spec: BookSpec): Uint8Array => buildXlsx(spec, { deflate });
const book = (price: number, note: string): BookSpec => ({
  sheets: [{ name: '売上', rows: [['品名', '単価', '備考'], ['剣', price, note], ['盾', 800, '']] }],
});

const NO_CHOICES: ExcelCellChoices = { cells: [], rows: [], cols: [], rest: null };

describe('Excel のコンフリクト（決定 34）', () => {
  let dir: string;
  let log: CommandLog;
  let manager: SessionManager;

  beforeEach(async () => {
    dir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(dir, { recursive: true });
    await git(dir, ['init', '--initial-branch=main']);
    await git(dir, ['config', 'user.name', 'T']);
    await git(dir, ['config', 'user.email', 't@example.invalid']);
    await git(dir, ['config', 'core.autocrlf', 'false']);
    await git(dir, ['config', 'commit.gpgsign', 'false']);
    log = new CommandLog();
    manager = new SessionManager({
      gitPath: GIT_PATH,
      tempDir: join(dir, '.ft-tmp'),
      commandLog: log,
      settings: () => DEFAULT_SETTINGS,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });

  async function write(rel: string, content: Uint8Array | string): Promise<void> {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  /** base → topic（相手側）と main（自分側）で書き換えて、マージで衝突させる。 */
  async function conflict(rel: string, base: Uint8Array | string, theirs: Uint8Array | string, ours: Uint8Array | string): Promise<void> {
    await write(rel, base);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'base']);
    await git(dir, ['switch', '-c', 'topic']);
    await write(rel, theirs);
    await git(dir, ['commit', '-am', 'topic']);
    await git(dir, ['switch', 'main']);
    await write(rel, ours);
    await git(dir, ['commit', '-am', 'main']);
    await git(dir, ['merge', 'topic']).catch(() => undefined);
  }

  async function logged<T>(f: () => Promise<T>): Promise<{ value: T; args: string[] }> {
    const before = log.size;
    const value = await f();
    const count = log.size - before;
    const added = count === 0 ? [] : log.recent(count).reverse();
    return { value, args: added.map((e) => e.args[0] ?? '') };
  }

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

  it('ブックは段を #49 で 3 回読み、作業ツリーは自分側と同じと分かる。共通祖先の同じ番地も引ける', async () => {
    await conflict('b.xlsx', xlsx(book(1000, 'base')), xlsx(book(1200, 'theirs')), xlsx(book(900, 'ours')));
    const session = await manager.open(dir);
    const { value: view, args } = await logged(() => session.getExcelComparison('b.xlsx'));
    expect(args).toEqual(['read-worktree', 'cat-file', 'cat-file', 'cat-file']);
    expect(view.conflict?.source).toBe('stages');
    expect(view.conflict?.worktree).toBe('ours');
    // ブックは段の方式でセル単位に採れる（docs/07）
    expect(view.conflict?.cellResolvable).toBe(true);
    const sheet = view.comparison.sheets[0];
    if (sheet === undefined) throw new Error('no sheet');
    expect(sheet.changedCells).toBe(2);
    expect(baseCellOf(view, sheet, 1, 1)?.raw).toBe('1000');
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

  it('決めていない違いが残っていれば書かない', async () => {
    await conflict('b.xlsx', xlsx(book(1000, 'base')), xlsx(book(1200, 'theirs')), xlsx(book(900, 'ours')));
    const session = await manager.open(dir);
    const view = await session.getExcelComparison('b.xlsx');
    await expect(session.resolveExcelConflict(view, { kind: 'cells', choices: NO_CHOICES })).rejects.toBeInstanceOf(
      ConflictUnsupportedError,
    );
  });
});
