import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings, type CommandLog } from '@feathertree/core';
import { createService, type Service } from '../src/handlers/service.js';
import { buildXlsx, type BookSpec } from '../../excel/test/xlsxBuilder.js';
import { GIT_PATH, createExcelRepo, xlsx, type ExcelRepo } from '../../core/test/excelFixture.js';

/*
 * Excel 差分の IPC ハンドラ（決定 33 / 対応表 #49）。
 *
 * 見るのは main の責務——パスの検証、数値の丸めと照合、トークンの失効（diff-stale）、
 * プロセス数（getView だけが #49 を打ち、残りは 0）、モードを離れたときの解放、
 * 最新の要求だけを生かすこと。中身の正しさは excel 層と core の excelView.test.ts で見てある。
 */

const book = (price: number, extra: (string | number)[][] = []): BookSpec => ({
  sheets: [
    { name: '売上', rows: [['品名', '単価'], ['剣', price], ['盾', 800], ...extra] },
    { name: 'メモ', rows: [['x']] },
  ],
});

describe('Excel 差分の IPC ハンドラ', () => {
  let dir: string;
  let service: Service;
  let settings: AppSettings;
  let commandLog: CommandLog;
  let repo: ExcelRepo;

  beforeEach(async () => {
    repo = await createExcelRepo();
    dir = repo.dir;
    settings = { ...DEFAULT_SETTINGS, viewMode: 'excel' };
    commandLog = repo.log;
    const sessions = repo.sessions(() => settings);
    service = createService({
      appInfo: () => ({
        appVersion: '0',
        electronVersion: '0',
        chromeVersion: '0',
        nodeVersion: '0',
        userDataDir: dir,
        isPackaged: false,
      }),
      git: () => ({ gitPath: GIT_PATH, source: 'path' }),
      gitVersion: () => null,
      sshPath: () => null,
      settings: () => settings,
      updateSettings: (patch) => {
        settings = { ...settings, ...patch } as AppSettings;
        return Promise.resolve(settings);
      },
      reloadGit: () => Promise.resolve(),
      sessions: () => sessions,
      commandLog: () => commandLog,
      pickDirectory: () => Promise.resolve(null),
      pickFile: () => Promise.resolve(null),
      notifyCloneProgress: () => undefined,
      openPath: () => Promise.resolve(''),
      showItemInFolder: () => undefined,
      resolveTerminal: () => Promise.resolve(null),
      launchTerminal: () => undefined,
    });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const write = (rel: string, content: Uint8Array | string): Promise<void> => repo.write(rel, content);

  async function openWithEdit(): Promise<string> {
    await write('data/item.xlsx', xlsx(book(1000)));
    await write('readme.txt', 'r');
    await repo.git('add', '-A');
    await repo.git('commit', '-m', 'init');
    await write('data/item.xlsx', xlsx(book(1200, [['弓', 600]])));
    const id = (await service.sessionOpen(dir)).id;
    await service.sessionLoad(id);
    return id;
  }

  /** f の間に載った実行ログの先頭語（古い順）。 */
  const logged = <T>(f: () => Promise<T>): Promise<{ value: T; args: string[] }> => repo.logged(f);

  it('シートの幾何に書式の表（M2）が載る', async () => {
    const styles =
      '<styleSheet><fonts><font><sz val="11"/></font><font><b/><color rgb="FFFF0000"/></font></fonts>' +
      '<fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>' +
      '<borders><border/></borders>' +
      '<cellXfs><xf fontId="0" fillId="0" borderId="0"/><xf fontId="1" fillId="2" borderId="0"/></cellXfs></styleSheet>';
    const styled = (price: number): Uint8Array =>
      buildXlsx(
        {
          sheets: [{ name: 'a', xml: `<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>${String(price)}</v></c></row></sheetData></worksheet>` }],
          extraParts: [{ name: 'xl/styles.xml', data: styles }],
        },
        { deflate: (d) => deflateRawSync(d) },
      );
    await write('s.xlsx', styled(1));
    await repo.git('add', '-A');
    await repo.git('commit', '-m', 'init');
    await write('s.xlsx', styled(2));
    const id = (await service.sessionOpen(dir)).id;
    await service.sessionLoad(id);
    const view = await service.excelGetView(id, 's.xlsx');
    const layout = await service.excelGetSheet(id, view.token, 0);
    expect(layout.newStyles[1]).toMatchObject({ bold: true, color: '#ff0000', fill: '#ffff00' });
    expect(layout.oldStyles).toHaveLength(2);
    expect(layout.newDefaultFontPt).toBe(11);
    const rows = await service.excelGetRows(id, view.token, 0, 0, 1);
    expect(rows.rows[0]?.new?.style).toEqual([1]);
  });

  it('セルの詳細・行ページ・行単位比較は表示形式を当てる（M3）。生の値は丸めない', async () => {
    const styles =
      '<styleSheet><fonts><font/></fonts><fills><fill/></fills><borders><border/></borders>' +
      '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
    const dated = (serial: number): Uint8Array =>
      buildXlsx(
        {
          sheets: [{ name: 'a', xml: `<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>${String(serial)}</v></c></row></sheetData></worksheet>` }],
          extraParts: [{ name: 'xl/styles.xml', data: styles }],
        },
        { deflate: (d) => deflateRawSync(d) },
      );
    await write('d.xlsx', dated(45366));
    await repo.git('add', '-A');
    await repo.git('commit', '-m', 'init');
    await write('d.xlsx', dated(45367.5));
    const id = (await service.sessionOpen(dir)).id;
    await service.sessionLoad(id);
    const view = await service.excelGetView(id, 'd.xlsx');
    const cell = await service.excelGetCell(id, view.token, 0, 0, 0);
    expect(cell.old?.display).toBe('2024/3/15');
    expect(cell.old?.raw).toBe('45366');
    expect(cell.new?.display).toBe('2024/3/16');
    expect(cell.new?.raw).toBe('45367.5');
    const rows = await service.excelGetRows(id, view.token, 0, 0, 1);
    expect(rows.rows[0]?.new?.text).toEqual(['2024/3/16']);
    const diff = await service.excelGetRowDiff(id, 'd.xlsx');
    expect(diff.sheets[0]?.hunks[0]?.rows[0]?.new).toEqual(['2024/3/16']);
  });

  it('一覧は Excel だけを返す（git は 0 プロセス）', async () => {
    const id = await openWithEdit();
    const { value, args } = await logged(() => service.excelListFiles(id));
    expect(args).toEqual([]);
    expect(value.entries.map((e) => [e.path, e.openable])).toEqual([['data/item.xlsx', true]]);
  });

  it('getView は #49 を 1 回だけ打ち、シート・行・セルは 0 プロセス', async () => {
    const id = await openWithEdit();
    const view = await logged(() => service.excelGetView(id, 'data/item.xlsx'));
    expect(view.args.filter((a) => a !== 'read-worktree')).toEqual(['cat-file']);
    expect(view.value.old.state).toBe('ok');
    expect(view.value.sheets.map((s) => [s.newName, s.mark])).toEqual([
      ['売上', 'changed'],
      ['メモ', 'same'],
    ]);
    const sales = view.value.sheets[0];
    expect(sales?.changedRows).toBe(1);
    expect(sales?.addedRows).toBe(1);

    const token = view.value.token;
    const rest = await logged(async () => {
      const layout = await service.excelGetSheet(id, token, 0);
      const rows = await service.excelGetRows(id, token, 0, 0, 10);
      const cell = await service.excelGetCell(id, token, 0, 1, 1);
      return { layout, rows, cell };
    });
    expect(rest.args).toEqual([]);
    expect(rest.value.layout.rowCount).toBe(4);
    expect(rest.value.layout.rowState).toEqual([0, 1, 0, 2]);
    expect(Array.isArray(rest.value.layout.rowHeight)).toBe(true);
    expect(rest.value.rows.rows[1]?.old?.text).toEqual(['剣', '1000']);
    expect(rest.value.rows.rows[1]?.new?.text).toEqual(['剣', '1200']);
    expect(rest.value.rows.rows[1]?.changedCols).toEqual([1]);
    expect(rest.value.cell.changed).toBe(true);
    expect(rest.value.cell.old?.address).toBe('B2');
  });

  it('同じファイルをもう一度見てもキャッシュから返す（0 プロセス）', async () => {
    const id = await openWithEdit();
    await service.excelGetView(id, 'data/item.xlsx');
    const again = await logged(() => service.excelGetView(id, 'data/item.xlsx'));
    expect(again.args).toEqual([]);
  });

  it('リポジトリの外を指すパスは invalid-path で、git は走らない', async () => {
    const id = await openWithEdit();
    for (const path of ['../outside.xlsx', join(dir, '..', 'x.xlsx')]) {
      const r = await logged(() => service.excelGetView(id, path).then(
        () => 'ok',
        (err: unknown) => (err as { name?: string }).name ?? 'error',
      ));
      expect(r.value).toBe('PathOutsideRootError');
      expect(r.args).toEqual([]);
      await expect(service.excelGetRowDiff(id, path)).rejects.toThrow();
    }
  });

  it('古いトークン・不正なシート / セルの指定は断る。行の範囲は丸める', async () => {
    const id = await openWithEdit();
    const view = await service.excelGetView(id, 'data/item.xlsx');
    await expect(service.excelGetSheet(id, 'bogus', 0)).rejects.toMatchObject({ dto: { kind: 'diff-stale' } });
    await expect(service.excelGetSheet(id, view.token, 9)).rejects.toThrow();
    await expect(service.excelGetSheet(id, view.token, 0.5)).rejects.toThrow();
    await expect(service.excelGetCell(id, view.token, 0, 99, 0)).rejects.toThrow();
    await expect(service.excelGetCell(id, view.token, 0, 0, -1)).rejects.toThrow();

    const clamped = await service.excelGetRows(id, view.token, 0, -5, 100_000);
    expect(clamped.start).toBe(0);
    expect(clamped.rows).toHaveLength(4);

    // 更新で status の世代が進めば、トークンは失効する
    await service.sessionRefresh(id, 'status');
    await expect(service.excelGetRows(id, view.token, 0, 0, 1)).rejects.toMatchObject({ dto: { kind: 'diff-stale' } });
  });

  it('行単位の比較（差分モードの C 案）はキャッシュを共有する', async () => {
    const id = await openWithEdit();
    const diff = await logged(() => service.excelGetRowDiff(id, 'data/item.xlsx'));
    expect(diff.args.filter((a) => a !== 'read-worktree')).toEqual(['cat-file']);
    expect(diff.value.sheets.map((s) => s.newName)).toEqual(['売上']);
    const rows = diff.value.sheets[0]?.hunks[0]?.rows ?? [];
    expect(rows.map((r) => r.kind)).toContain('added');
    const view = await logged(() => service.excelGetView(id, 'data/item.xlsx'));
    expect(view.args).toEqual([]);
  });

  it('差分モード・Excel 差分モード以外へ移ったら比較を手放す', async () => {
    const id = await openWithEdit();
    const view = await service.excelGetView(id, 'data/item.xlsx');
    await service.settingsUpdate({ viewMode: 'diff' });
    await expect(service.excelGetSheet(id, view.token, 0)).resolves.toBeDefined();
    await service.settingsUpdate({ viewMode: 'log' });
    await expect(service.excelGetSheet(id, view.token, 0)).rejects.toMatchObject({ dto: { kind: 'diff-stale' } });
  });

  it('別のファイルを選び直したら、前の要求は止めて最新だけを返す', async () => {
    await write('a.xlsx', xlsx(book(1)));
    await write('b.xlsx', xlsx(book(1)));
    await repo.git('add', '-A');
    await repo.git('commit', '-m', 'init');
    await write('a.xlsx', xlsx(book(2)));
    await write('b.xlsx', xlsx(book(3)));
    const id = (await service.sessionOpen(dir)).id;
    await service.sessionLoad(id);

    const first = service.excelGetView(id, 'a.xlsx').then(
      () => 'done',
      (err: unknown) => (err as { name?: string }).name ?? 'error',
    );
    const second = await service.excelGetView(id, 'b.xlsx');
    expect(second.path).toBe('b.xlsx');
    // 先の要求は止められたか、止められる前に終わったか（どちらでも最新のキャッシュは b）
    expect(['done', 'GitCancelledError']).toContain(await first);
    await expect(service.excelGetSheet(id, second.token, 0)).resolves.toBeDefined();
  });
  /** base → topic（相手側）と main（自分側）で書き換えて、マージで衝突させる。 */
  async function openWithConflict(rel: string, base: Uint8Array | string, theirs: Uint8Array | string, ours: Uint8Array | string): Promise<string> {
    await repo.conflict(rel, base, theirs, ours);
    const id = (await service.sessionOpen(dir)).id;
    await service.sessionLoad(id);
    return id;
  }

  describe('コンフリクトの採用（決定 34）', () => {
    it('未マージのブックは自分側 ｜ 相手側の比較になる', async () => {
      const id = await openWithConflict('b.xlsx', xlsx(book(1000)), xlsx(book(1200)), xlsx(book(900)));
      const view = await service.excelGetView(id, 'b.xlsx');
      expect(view.conflict?.source).toBe('stages');
      // ブックもセル単位で採れる（docs/07）。売上シートの B2 だけが違う。メモシートは同じ
      expect(view.conflict?.cellResolvable).toBe(true);
      expect(view.sheets[0]?.conflict).toEqual({ cells: [1, 1], rows: [], blocked: [], bothBlocked: null });
      expect(view.sheets[1]?.conflict).toEqual({ cells: [], rows: [], blocked: [], bothBlocked: null });
      const cell = await service.excelGetCell(id, view.token, 0, 1, 1);
      expect(cell.old?.raw).toBe('900');
      expect(cell.new?.raw).toBe('1200');
    });

    it('古いトークン・不正な側や座標・リポジトリ外のパスは断る', async () => {
      const id = await openWithConflict('d.csv', 'a,1\n', 'a,2\n', 'a,3\n');
      const view = await service.excelGetView(id, 'd.csv');
      const file = { kind: 'file', side: 'theirs' } as const;
      await expect(service.excelResolveConflict(id, { path: 'd.csv', token: 'bogus', resolution: file })).rejects.toMatchObject({
        dto: { kind: 'diff-stale' },
      });
      await expect(
        service.excelResolveConflict(id, { path: 'd.csv', token: view.token, resolution: { kind: 'file', side: 'mine' as never } }),
      ).rejects.toThrow();
      const cells = (row: number, col: number) => ({
        kind: 'cells' as const,
        choices: { cells: [{ sheet: 0, row, col, side: 'ours' as const }], rows: [], cols: [], rest: null },
      });
      await expect(service.excelResolveConflict(id, { path: 'd.csv', token: view.token, resolution: cells(99, 0) })).rejects.toThrow();
      await expect(service.excelResolveConflict(id, { path: 'd.csv', token: view.token, resolution: cells(0, 0.5) })).rejects.toThrow();
      await expect(
        service.excelResolveConflict(id, { path: '../x.csv', token: view.token, resolution: file }),
      ).rejects.toThrow();
    });

    it('CSV をセル単位で採用すると書き戻し、比較を作り直す（status は未マージのまま）', async () => {
      const id = await openWithConflict('d.csv', 'h,v\n1,a\n', 'h,v\n1,b\n', 'h,v\n1,c\n');
      const view = await service.excelGetView(id, 'd.csv');
      expect(view.conflict?.source).toBe('markers');
      expect(view.sheets[0]?.conflict?.cells).toEqual([1, 1]);
      await service.excelResolveConflict(id, {
        path: 'd.csv',
        token: view.token,
        resolution: { kind: 'cells', choices: { cells: [{ sheet: 0, row: 1, col: 1, side: 'theirs' }], rows: [], cols: [], rest: null } },
      });
      expect(await readFile(join(dir, 'd.csv'), 'utf8')).toBe('h,v\n1,b\n');
      await expect(service.excelGetSheet(id, view.token, 0)).rejects.toMatchObject({ dto: { kind: 'diff-stale' } });
      const after = await service.excelGetView(id, 'd.csv');
      // マーカーが無くなったので index の段の比較に替わる
      expect(after.conflict?.source).toBe('stages');
    });

    it('マージをキャンセルする（#51）は確認を求め、確認後はマージ前に戻る', async () => {
      const id = await openWithConflict('d.csv', 'a,1\n', 'a,2\n', 'a,3\n');
      await expect(service.mergeAbort(id)).rejects.toMatchObject({
        dto: { kind: 'needs-confirmation', confirmation: { action: 'abort-merge' } },
      });
      const { args } = await logged(() => service.mergeAbort(id, true));
      expect(args[0]).toBe('merge');
      expect(await readFile(join(dir, 'd.csv'), 'utf8')).toBe('a,3\n');
      const page = await service.statusGetPage(id, { offset: 0, limit: 10, filter: { group: 'changes' } });
      expect(page.entries.some((e) => e.kind === 'unmerged')).toBe(false);
      // もう一度は取り消せない（取り消せるマージが無い）
      // （IPC の包みが git-failed と「取り消せるマージがありません」に写す。errorMapping のテストで確かめる）
      await expect(service.mergeAbort(id, true)).rejects.toMatchObject({ name: 'GitCommandError' });
    });

    it('作業ツリーがどちらの側とも違うときのファイル単位の採用は確認を求める', async () => {
      const id = await openWithConflict('b.xlsx', xlsx(book(1000)), xlsx(book(1200)), xlsx(book(900)));
      await write('b.xlsx', xlsx(book(5)));
      const view = await service.excelGetView(id, 'b.xlsx');
      const req = { path: 'b.xlsx', token: view.token, resolution: { kind: 'file', side: 'theirs' } } as const;
      await expect(service.excelResolveConflict(id, req)).rejects.toMatchObject({
        dto: { kind: 'needs-confirmation', confirmation: { action: 'overwrite-conflict-worktree' } },
      });
      const { args } = await logged(() => service.excelResolveConflict(id, req, true));
      expect(args).toEqual(['read-worktree', 'cat-file', 'write-worktree']);
    });
  });
});
