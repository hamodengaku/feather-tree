import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitCancelledError } from '@feathertree/git';
import { DEFAULT_LIMITS, openWorkbook } from '@feathertree/excel';
import {
  CommandLog,
  DEFAULT_SETTINGS,
  SessionManager,
  excelToken,
  geometryOf,
  rowDiffOf,
  zlibInflater,
  type RepositorySession,
} from '../src/index.js';
import { buildXlsx, type BookSpec } from '../../excel/test/xlsxBuilder.js';

/*
 * Excel 差分の比較の組み立て（決定 33）。実 git と本物の deflate を使う。
 *
 * 見るもの:
 *   - HEAD 側は #49 の 1 プロセス、作業ツリー側は git 0 プロセス（実行ログに read-worktree で載る）
 *   - HEAD に無いと分かっているもの（未追跡・index で新規）では #49 を打たない
 *   - リネームは元のパスで HEAD を読む
 *   - 片側が駄目でも、もう片側は見せる（LFS の失敗・ポインタのまま）
 *   - キャッシュは status の世代が進むまで使い回し、Excel 以外を見たら手放す
 */

const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/core-excel-tests');
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
const table = (price: number): BookSpec => ({
  sheets: [{ name: '売上', rows: [['品名', '単価'], ['剣', price], ['盾', 800]] }],
});

describe('Excel の比較（決定 33）', () => {
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

  async function commit(message = 'c'): Promise<void> {
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', message]);
  }

  /** f を実行している間に載った実行ログの先頭語。 */
  async function logged<T>(f: () => Promise<T>): Promise<{ value: T; args: string[] }> {
    const before = log.size;
    const value = await f();
    const count = log.size - before;
    // recent() は新しい順。0 件を渡すと全件になるので避ける
    const added = count === 0 ? [] : log.recent(count).reverse();
    return { value, args: added.map((e) => e.args[0] ?? '') };
  }

  async function open(): Promise<RepositorySession> {
    return manager.open(dir);
  }

  it('変更したブックは HEAD を #49 で 1 回読み、作業ツリーは直接読む', async () => {
    await write('data/item.xlsx', xlsx(table(1000)));
    await commit();
    await write('data/item.xlsx', xlsx(table(1200)));
    const session = await open();

    const { value: view, args } = await logged(() => session.getExcelComparison('data/item.xlsx'));
    expect(args).toEqual(['cat-file', 'read-worktree']);
    expect(view.old.state).toBe('ok');
    expect(view.new.state).toBe('ok');
    const sheet = view.comparison.sheets[0];
    expect(sheet?.mark).toBe('changed');
    expect(sheet?.changedCells).toBe(1);
    expect(geometryOf(view, 0)?.rowCount).toBe(3);
    expect(rowDiffOf(view, 3).sheets[0]?.hunks).toHaveLength(1);
  });

  it('同じ status の世代ならキャッシュを返し、世代が進めば読み直す', async () => {
    await write('a.xlsx', xlsx(table(1)));
    await commit();
    await write('a.xlsx', xlsx(table(2)));
    const session = await open();
    const first = await session.getExcelComparison('a.xlsx');
    const again = await logged(() => session.getExcelComparison('a.xlsx'));
    expect(again.value).toBe(first);
    expect(again.args).toEqual([]);
    expect(session.excelByToken(excelToken(first))).toBe(first);

    await session.refreshStatus();
    expect(session.excelByToken(excelToken(first))).toBeNull();
    const rebuilt = await logged(() => session.getExcelComparison('a.xlsx'));
    expect(rebuilt.args).toEqual(['cat-file', 'read-worktree']);
  });

  it('未追跡・index で新規のファイルは HEAD を読まない（0 プロセス）', async () => {
    await write('seed.txt', 'x');
    await commit();
    await write('new.xlsx', xlsx(table(1)));
    const session = await open();
    const untracked = await logged(() => session.getExcelComparison('new.xlsx'));
    expect(untracked.args).toEqual(['read-worktree']);
    expect(untracked.value.old.state).toBe('absent');
    expect(untracked.value.comparison.sheets[0]?.mark).toBe('added');

    await git(dir, ['add', 'new.xlsx']);
    await session.refreshStatus();
    const staged = await logged(() => session.getExcelComparison('new.xlsx'));
    expect(staged.args).toEqual(['read-worktree']);
  });

  it('作業ツリーで削除したファイルは新側が absent', async () => {
    await write('gone.xlsx', xlsx(table(1)));
    await commit();
    await rm(join(dir, 'gone.xlsx'));
    const session = await open();
    const view = await session.getExcelComparison('gone.xlsx');
    expect(view.old.state).toBe('ok');
    expect(view.new.state).toBe('absent');
    expect(view.comparison.sheets[0]?.mark).toBe('removed');
  });

  it('リネームは元のパスで HEAD を読む', async () => {
    await write('old.xlsx', xlsx(table(1)));
    await commit();
    await git(dir, ['mv', 'old.xlsx', 'renamed.xlsx']);
    const session = await open();
    const view = await session.getExcelComparison('renamed.xlsx');
    expect(view.headPath).toBe('old.xlsx');
    expect(view.old.state).toBe('ok');
    expect(view.comparison.sheets[0]?.mark).toBe('same');
  });

  it('作業ツリーが LFS のポインタのままなら、その側だけ lfs-pointer', async () => {
    await write('a.xlsx', xlsx(table(1)));
    await commit();
    await write('a.xlsx', 'version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 10\n');
    const session = await open();
    const view = await session.getExcelComparison('a.xlsx');
    expect(view.old.state).toBe('ok');
    expect(view.new.state).toBe('lfs-pointer');
  });

  it('smudge が失敗したら（git-lfs が無い等）旧側は lfs-failed で、新側は見せる', async () => {
    await write('a.xlsx', xlsx(table(1)));
    await commit();
    // clean は素通しにする。status が作業ツリーのファイルを見直すとき（racy git）は clean を走らせるので、
    // clean まで失敗させると、失敗させたい smudge より先に status が落ちる（並列実行で実際に落ちた）
    await git(dir, ['config', 'filter.ftfail.clean', 'cat']);
    await git(dir, ['config', 'filter.ftfail.smudge', 'false']);
    await git(dir, ['config', 'filter.ftfail.required', 'true']);
    await write('.gitattributes', '*.xlsx filter=ftfail\n');
    const session = await open();
    const view = await session.getExcelComparison('a.xlsx');
    expect(view.old.state).toBe('lfs-failed');
    expect(view.old.detail).toMatch(/smudge/);
    expect(view.new.state).toBe('ok');
  });

  it('Excel 以外の diff を取ったら、抱えている比較を手放す', async () => {
    await write('a.xlsx', xlsx(table(1)));
    await write('b.txt', 'b');
    await commit();
    await write('a.xlsx', xlsx(table(2)));
    await write('b.txt', 'bb');
    const session = await open();
    const view = await session.getExcelComparison('a.xlsx');
    await session.getDiff('a.xlsx', false);
    expect(session.excelByToken(excelToken(view))).toBe(view);
    await session.getDiff('b.txt', false);
    expect(session.excelByToken(excelToken(view))).toBeNull();
  });

  it('後から始めた組み立てが勝つ（遅れて終わった古い組み立てはキャッシュに書かない）', async () => {
    await write('a.xlsx', xlsx(table(1)));
    await write('b.xlsx', xlsx(table(1)));
    await commit();
    await write('a.xlsx', xlsx(table(2)));
    await write('b.xlsx', xlsx(table(3)));
    const session = await open();
    const first = session.getExcelComparison('a.xlsx');
    const second = await session.getExcelComparison('b.xlsx');
    await first;
    expect(session.excelByToken(excelToken(second))).toBe(second);
  });

  it('中止されたら GitCancelledError', async () => {
    await write('a.xlsx', xlsx(table(1)));
    await commit();
    await write('a.xlsx', xlsx(table(2)));
    const session = await open();
    const controller = new AbortController();
    controller.abort();
    await expect(session.getExcelComparison('a.xlsx', controller.signal)).rejects.toBeInstanceOf(GitCancelledError);
  });

  it('.xls / .xlsb は git を起動せずに案内の状態だけを返す', async () => {
    await write('legacy.xls', 'x');
    await commit();
    await write('legacy.xls', 'y');
    const session = await open();
    const { value, args } = await logged(() => session.getExcelComparison('legacy.xls'));
    expect(args).toEqual([]);
    expect(value.old.state).toBe('encrypted-or-legacy');
    expect(value.new.state).toBe('encrypted-or-legacy');
    expect(value.comparison.sheets).toEqual([]);
  });

  it('組み立て中に手放したら、終わった結果をキャッシュに戻さない', async () => {
    await write('a.xlsx', xlsx(table(1)));
    await commit();
    await write('a.xlsx', xlsx(table(2)));
    const session = await open();
    const building = session.getExcelComparison('a.xlsx');
    session.releaseExcel();
    const built = await building;
    expect(session.excelByToken(excelToken(built))).toBeNull();
  });

  it('一覧はロックファイルを除き、.xls は開けない印を付け、ステージと未ステージの両方ある変更も 1 件', async () => {
    await write('a.xlsx', xlsx(table(1)));
    await write('legacy.xls', 'x');
    await commit();
    await write('a.xlsx', xlsx(table(2)));
    await git(dir, ['add', 'a.xlsx']);
    await write('a.xlsx', xlsx(table(3)));
    await write('legacy.xls', 'y');
    await write('~$a.xlsx', 'lock');
    await write('notes.txt', 'n');
    const session = await open();
    const list = session.listExcelFiles();
    expect(list.entries.map((e) => [e.entry.path, e.openable])).toEqual([
      ['a.xlsx', true],
      ['legacy.xls', false],
    ]);
    expect(list.truncated).toBe(false);
  });
});

describe('deflate の展開（zlibInflater）', () => {
  it('上限を超えたら too-large、壊れていれば broken', () => {
    const packed = deflateRawSync(new Uint8Array(1_000_000));
    expect(zlibInflater(packed, 2_000_000).ok).toBe(true);
    expect(zlibInflater(packed, 1000)).toEqual({ ok: false, reason: 'too-large' });
    expect(zlibInflater(new Uint8Array([0xff, 0xff, 0xff]), 1000)).toEqual({ ok: false, reason: 'broken' });
  });

  it('宣言サイズを偽った ZIP 爆弾は、本物の deflate でも上限で止まる', () => {
    const huge = '<worksheet><sheetData>' + ' '.repeat(5_000_000) + '</sheetData></worksheet>';
    const bytes = buildXlsx({ sheets: [{ name: 'a', xml: huge }] }, { deflate });
    const r = openWorkbook(bytes, zlibInflater, { ...DEFAULT_LIMITS, maxEntryBytes: 1_000_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.workbook.sheets[0]?.problem).toBe('too-large');
  });
});
