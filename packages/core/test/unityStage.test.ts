import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type GitContext, readBlobText } from '@feathertree/git';
import {
  buildLineIndex,
  buildRows,
  buildSideTree,
  mergeTrees,
  parseUnityFile,
  type PropertyRow,
  selectionForRow,
  selectionForRows,
  type UnityFile,
  verifyAlignment,
} from '@feathertree/unity';
import { CommandLog, DEFAULT_SETTINGS, SessionManager, SessionOperations } from '../src/index.js';

/*
 * **設計の心臓部の証明**（Phase 12 M3 / 設計 A）。
 *
 * 「表の 1 行」を選んで押したとき、**狙った 1 行だけ**が index に入ることを
 * 実 git で確かめる。ここが通らなければ、この機能は成立しない。
 *
 * 通る道筋は次のとおりで、パッチ本体は一切ここで組み立てない
 * （組み立てるのは main が読み直した diff から。決定「やらないこと」）。
 *
 *   #48 で旧側の全文 → 作業ツリーを直接読んで新側の全文
 *     → パース → ヒエラルキー → 表の行（行番号つき）
 *     → #18 の diff から索引 → hunk / 行の座標 → ops.stageHunks
 */

const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/core-unity-tests');
const GIT_PATH = process.env['FT_TEST_GIT'] ?? 'git';
const LF = String.fromCharCode(10);

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(GIT_PATH, [...args], { cwd, shell: false, windowsHide: true });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('error', rej);
    child.on('close', (code) =>
      code === 0 ? res(out) : rej(new Error('git failed: ' + String(code) + ' ' + args.join(' '))),
    );
  });
}

/** 2 つのプロパティを持つ Prefab。値を差し替えて「編集」を作る。 */
function prefab(scale: string, active: string): string {
  return [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!1 &100',
    'GameObject:',
    '  m_Component:',
    '  - component: {fileID: 101}',
    '  m_Name: Player',
    '  m_IsActive: ' + active,
    '--- !u!4 &101',
    'Transform:',
    '  m_GameObject: {fileID: 100}',
    '  m_LocalPosition: {x: 0, y: 0, z: 0}',
    '  m_LocalScale: {x: ' + scale + ', y: 1, z: 1}',
    '  m_Children: []',
    '  m_Father: {fileID: 0}',
    '',
  ].join(LF);
}

describe('Unity のパラメータ単位ステージ（決定 32 / 設計 A）', () => {
  let dir: string;
  let manager: SessionManager;
  let ctx: GitContext;

  beforeEach(async () => {
    dir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(dir, { recursive: true });
    await git(dir, ['init', '--initial-branch=main']);
    await git(dir, ['config', 'user.name', 'T']);
    await git(dir, ['config', 'user.email', 't@example.invalid']);
    await git(dir, ['config', 'core.autocrlf', 'false']);

    ctx = { gitPath: GIT_PATH, cwd: dir, tempDir: join(dir, '.ft-tmp') };
    manager = new SessionManager({
      gitPath: GIT_PATH,
      tempDir: join(dir, '.ft-tmp'),
      commandLog: new CommandLog(),
      settings: () => DEFAULT_SETTINGS,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      () => undefined,
    );
  });

  async function write(rel: string, content: string): Promise<void> {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  /** 旧側（index）と新側（作業ツリー）を読んで、表の行まで組む。 */
  async function openView(path: string): Promise<{
    ops: SessionOperations;
    rows: readonly PropertyRow[];
    index: ReturnType<typeof buildLineIndex>;
    oldFile: UnityFile;
    newFile: UnityFile;
  }> {
    const session = await manager.open(dir);
    const ops = new SessionOperations(session);

    // #48（旧側 = index の blob）と、作業ツリーの直接読み（新側。git は 0 プロセス）
    const oldBlob = await readBlobText(ctx, 'index', path);
    const oldFile = parseUnityFile(oldBlob?.text ?? '');
    const newFile = parseUnityFile(await readFile(join(dir, path), 'utf8'));

    // 座標の出どころは **apply が読み直すのと同じ条件の diff**（A-3）
    const diff = await session.getDiffForPatch(path, false);
    expect(diff).not.toBeNull();
    if (diff === null) throw new Error('no diff');

    // 全文と diff が同じものを指しているか（A-2 / F-6）
    expect(verifyAlignment(oldFile, diff, 'old')).toBe(true);
    expect(verifyAlignment(newFile, diff, 'new')).toBe(true);

    const merged = mergeTrees(buildSideTree(oldFile), buildSideTree(newFile));
    expect(merged.length).toBeGreaterThan(0);

    // Transform（&101）のノードの表を組む
    const rows = buildRows(
      oldFile,
      oldFile.byAnchor.get('101') ?? null,
      newFile,
      newFile.byAnchor.get('101') ?? null,
    );

    return { ops, rows, index: buildLineIndex(diff), oldFile, newFile };
  }

  it('1 パラメータだけステージすると、狙った 1 行だけが index に入る', async () => {
    await write('Player.prefab', prefab('1', '1'));
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);

    // 2 か所を編集する（Transform の m_LocalScale.x と、GameObject の m_IsActive）
    await write('Player.prefab', prefab('2.5', '0'));

    const { ops, rows, index } = await openView('Player.prefab');

    const scale = rows.find((r) => r.key === 'm_LocalScale.x');
    expect(scale?.state).toBe('changed');
    if (scale === undefined) throw new Error('row missing');

    const picks = selectionForRow(index, scale);
    expect(picks).not.toBeNull();
    if (picks === null) throw new Error('not stageable');

    await ops.stageHunks('Player.prefab', picks);

    const staged = await git(dir, ['diff', '--cached', '--', 'Player.prefab']);
    // 狙った行だけが index に入っている
    expect(staged).toContain('+  m_LocalScale: {x: 2.5, y: 1, z: 1}');
    expect(staged).not.toContain('m_IsActive');

    // もう片方は未ステージのまま残っている
    const unstaged = await git(dir, ['diff', '--', 'Player.prefab']);
    expect(unstaged).toContain('m_IsActive');
    expect(unstaged).not.toContain('m_LocalScale');
  });

  it('作業ツリーには一切触れない（apply --cached の担保）', async () => {
    await write('Player.prefab', prefab('1', '1'));
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('Player.prefab', prefab('2.5', '0'));

    const before = await readFile(join(dir, 'Player.prefab'), 'utf8');
    const { ops, rows, index } = await openView('Player.prefab');
    const scale = rows.find((r) => r.key === 'm_LocalScale.x');
    if (scale === undefined) throw new Error('row missing');
    const picks = selectionForRow(index, scale);
    if (picks === null) throw new Error('not stageable');
    await ops.stageHunks('Player.prefab', picks);

    expect(await readFile(join(dir, 'Player.prefab'), 'utf8')).toBe(before);
  });

  it('ノード 1 つをステージすると、そのノードの変更行だけが入る（コンポーネントをステージ）', async () => {
    await write('Player.prefab', prefab('1', '1'));
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('Player.prefab', prefab('2.5', '0'));

    const { ops, rows, index } = await openView('Player.prefab');
    const picks = selectionForRows(index, rows);
    expect(picks).not.toBeNull();
    if (picks === null) throw new Error('not stageable');

    await ops.stageHunks('Player.prefab', picks);

    const staged = await git(dir, ['diff', '--cached', '--', 'Player.prefab']);
    // Transform の変更だけが入り、GameObject の m_IsActive は入らない
    expect(staged).toContain('m_LocalScale');
    expect(staged).not.toContain('m_IsActive');
  });

  it('未変更の行はステージできない（ボタンを出さない）', async () => {
    await write('Player.prefab', prefab('1', '1'));
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('Player.prefab', prefab('2.5', '1'));

    const { rows, index } = await openView('Player.prefab');
    const untouched = rows.find((r) => r.key === 'm_LocalScale.y');
    expect(untouched?.state).toBe('same');
    if (untouched === undefined) throw new Error('row missing');
    expect(selectionForRow(index, untouched)).toBeNull();
  });

  it('アンステージも同じ座標で戻せる', async () => {
    await write('Player.prefab', prefab('1', '1'));
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('Player.prefab', prefab('2.5', '0'));
    await git(dir, ['add', 'Player.prefab']);

    const session = await manager.open(dir);
    const ops = new SessionOperations(session);

    // ステージ済みを見ているので、旧側は HEAD・新側は index
    const oldFile = parseUnityFile((await readBlobText(ctx, 'HEAD', 'Player.prefab'))?.text ?? '');
    const newFile = parseUnityFile((await readBlobText(ctx, 'index', 'Player.prefab'))?.text ?? '');
    const diff = await session.getDiffForPatch('Player.prefab', true);
    if (diff === null) throw new Error('no diff');
    expect(verifyAlignment(newFile, diff, 'new')).toBe(true);

    const rows = buildRows(
      oldFile,
      oldFile.byAnchor.get('101') ?? null,
      newFile,
      newFile.byAnchor.get('101') ?? null,
    );
    const scale = rows.find((r) => r.key === 'm_LocalScale.x');
    if (scale === undefined) throw new Error('row missing');
    const picks = selectionForRow(buildLineIndex(diff), scale);
    if (picks === null) throw new Error('not stageable');

    await ops.unstageHunks('Player.prefab', picks);

    const staged = await git(dir, ['diff', '--cached', '--', 'Player.prefab']);
    // m_LocalScale だけが index から戻り、m_IsActive はステージされたまま
    expect(staged).not.toContain('m_LocalScale');
    expect(staged).toContain('m_IsActive');
  });
});

describe('PrefabInstance の m_Modifications をステージする（要件 9）', () => {
  let dir: string;
  let manager: SessionManager;
  let ctx: GitContext;

  /** m_Modifications の要素を 1 件足す / 足さない 2 つの版。 */
  function variant(extra: boolean): string {
    return [
      '%YAML 1.1',
      '%TAG !u! tag:unity3d.com,2011:',
      '--- !u!1001 &50',
      'PrefabInstance:',
      '  m_Modification:',
      '    m_TransformParent: {fileID: 0}',
      '    m_Modifications:',
      '    - target: {fileID: 111, guid: aaa, type: 3}',
      '      propertyPath: m_Name',
      '      value: Player',
      '      objectReference: {fileID: 0}',
      ...(extra
        ? [
            '    - target: {fileID: 111, guid: aaa, type: 3}',
            '      propertyPath: m_LocalScale.x',
            '      value: 1.2',
            '      objectReference: {fileID: 0}',
          ]
        : []),
      '    m_RemovedComponents: []',
      '  m_SourcePrefab: {fileID: 100100000, guid: bbb, type: 3}',
      '',
    ].join(LF);
  }

  beforeEach(async () => {
    dir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(dir, { recursive: true });
    await git(dir, ['init', '--initial-branch=main']);
    await git(dir, ['config', 'user.name', 'T']);
    await git(dir, ['config', 'user.email', 't@example.invalid']);
    await git(dir, ['config', 'core.autocrlf', 'false']);
    ctx = { gitPath: GIT_PATH, cwd: dir, tempDir: join(dir, '.ft-tmp') };
    manager = new SessionManager({
      gitPath: GIT_PATH,
      tempDir: join(dir, '.ft-tmp'),
      commandLog: new CommandLog(),
      settings: () => DEFAULT_SETTINGS,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      () => undefined,
    );
  });

  it('1 要素を足す変更をステージすると、index の YAML が壊れない（4 行そろって入る）', async () => {
    const file = join(dir, 'Variant.prefab');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, variant(false), 'utf8');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await writeFile(file, variant(true), 'utf8');

    const session = await manager.open(dir);
    const ops = new SessionOperations(session);

    const oldFile = parseUnityFile((await readBlobText(ctx, 'index', 'Variant.prefab'))?.text ?? '');
    const newFile = parseUnityFile(await readFile(file, 'utf8'));
    const diff = await session.getDiffForPatch('Variant.prefab', false);
    if (diff === null) throw new Error('no diff');

    const rows = buildRows(
      oldFile,
      oldFile.byAnchor.get('50') ?? null,
      newFile,
      newFile.byAnchor.get('50') ?? null,
    );
    const added = rows.find((r) => r.key === 'm_LocalScale.x');
    expect(added?.state).toBe('added');
    if (added === undefined) throw new Error('row missing');

    const picks = selectionForRow(buildLineIndex(diff), added);
    if (picks === null) throw new Error('not stageable');
    await ops.stageHunks('Variant.prefab', picks);

    // index の中身を読み直し、YAML として読めて要素が 2 つになっていること
    const indexed = parseUnityFile((await readBlobText(ctx, 'index', 'Variant.prefab'))?.text ?? '');
    const indexedRows = buildRows(null, null, indexed, indexed.byAnchor.get('50') ?? null);
    expect(indexedRows.map((r) => r.key)).toContain('m_Name');
    expect(indexedRows.map((r) => r.key)).toContain('m_LocalScale.x');

    // `- target:` の行が落ちていない（落ちると壊れた YAML になる）
    const staged = await git(dir, ['diff', '--cached', '--', 'Variant.prefab']);
    expect(staged).toContain('+    - target: {fileID: 111, guid: aaa, type: 3}');
    expect(staged).toContain('+      propertyPath: m_LocalScale.x');
    expect(staged).toContain('+      value: 1.2');
    expect(staged).toContain('+      objectReference: {fileID: 0}');
  });
});
