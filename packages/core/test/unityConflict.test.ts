import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandLog,
  ConflictUnsupportedError,
  DEFAULT_SETTINGS,
  rowsFor,
  SessionManager,
  SessionOperations,
  StaleDiffError,
  type RepositorySession,
} from '../src/index.js';

/*
 * Unity モードの未マージ表示（Phase 12 M8）。実 git でマージを衝突させて確かめる。
 *
 * 見るもの:
 *   - 旧 = 自分側（:2:）・新 = 相手側（:3:）で比べる。作業ツリーのマーカーを読み込まない
 *   - 打つ git は #48 だけ（自分側・相手側・共通祖先。結合 diff の #18 は打たない）
 *   - GameObject 単位の書き出し: 選び残しは書かない、作業ツリーが動いていたら書かない、index は触らない
 *   - #51（マージをキャンセル）
 *   - ステージ不可（refusal: conflict）で、表の行に座標が付かない
 *   - 削除との衝突は欠けた側を absent にする
 *   - index には触れない（未マージのまま）
 */

const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/core-unity-conflict-tests');
const GIT_PATH = process.env['FT_TEST_GIT'] ?? 'git';
const LF = String.fromCharCode(10);

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

/** GameObject + Transform の Prefab。名前と拡大率を差し替えて「編集」を作る。 */
function prefab(name: string, scale: string): string {
  return [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!1 &100',
    'GameObject:',
    '  m_Component:',
    '  - component: {fileID: 101}',
    '  m_Name: ' + name,
    '  m_IsActive: 1',
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

describe('Unity モードの未マージ表示（決定 32 / M8）', () => {
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

  /** base → topic（相手側）と main（自分側）で書き換えて、マージで衝突させる。null はその側で削除。 */
  async function conflict(rel: string, base: string, theirs: string | null, ours: string | null): Promise<void> {
    await writeFile(join(dir, rel), base);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'base']);
    await git(dir, ['switch', '-c', 'topic']);
    if (theirs === null) await git(dir, ['rm', '-q', rel]);
    else await writeFile(join(dir, rel), theirs);
    await git(dir, ['commit', '-am', 'topic']);
    await git(dir, ['switch', 'main']);
    if (ours === null) await git(dir, ['rm', '-q', rel]);
    else await writeFile(join(dir, rel), ours);
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

  it('自分側と相手側を比べ、#48 だけを打ち、ステージは不可', async () => {
    await conflict('P.prefab', prefab('Player', '1'), prefab('Hero', '2'), prefab('Avatar', '3'));
    const session = await manager.open(dir);
    expect(await unmerged(session, 'P.prefab')).toBe(true);

    const { value: view, args } = await logged(() => session.getUnityView('P.prefab', false));
    expect(args).toEqual(['show', 'show', 'read-worktree', 'show']);
    expect(view.format).toBe('yaml');
    expect(view.stageable).toBe(false);
    expect(view.refusal).toBe('conflict');
    expect(view.conflict).toMatchObject({ ours: 'present', theirs: 'present', worktreeHasMarkers: true, worktree: 'markers' });
    // GameObject と Transform の両方を両側が変えた → GameObject（100）だけが選ぶ単位
    expect(view.conflict?.plan?.conflictUnits).toEqual(['100']);

    // マーカー入りの作業ツリーではなく、両側の YAML から組んでいる（追加だけにならない）
    expect(view.nodes.map((n) => n.id)).toEqual(['100', '101']);
    const go = rowsFor(view, '100');
    const name = go.find((r) => r.row.key === 'm_Name');
    expect(name?.row.before).toBe('Avatar');
    expect(name?.row.after).toBe('Hero');
    expect(go.every((r) => r.selection === null)).toBe(true);

    const scale = rowsFor(view, '101').find((r) => r.row.key === 'm_LocalScale.x');
    expect([scale?.row.before, scale?.row.after]).toEqual(['3', '2']);

    // index には触れていない
    expect(await unmerged(session, 'P.prefab')).toBe(true);
  });

  it('相手側で削除された衝突は、相手側を absent にして全ノード削除として見せる', async () => {
    await conflict('P.prefab', prefab('Player', '1'), null, prefab('Avatar', '3'));
    const session = await manager.open(dir);
    expect(await unmerged(session, 'P.prefab')).toBe(true);

    const view = await session.getUnityView('P.prefab', false);
    expect(view.conflict).toMatchObject({ ours: 'present', theirs: 'absent', worktreeHasMarkers: false });
    // 片側で削除された衝突は GameObject 単位では解消できない
    expect(view.conflict?.plan).toBeNull();
    expect(view.refusal).toBe('conflict');
    expect(view.nodes.every((n) => n.mark === 'removed')).toBe(true);
  });

  it('作業ツリーのマーカーを解消した後も、ステージするまでは自分側と相手側を見せる', async () => {
    await conflict('P.prefab', prefab('Player', '1'), prefab('Hero', '2'), prefab('Avatar', '3'));
    await writeFile(join(dir, 'P.prefab'), prefab('Hero', '2'));
    const session = await manager.open(dir);

    const view = await session.getUnityView('P.prefab', false);
    expect(view.conflict?.worktreeHasMarkers).toBe(false);
    expect(rowsFor(view, '100').find((r) => r.row.key === 'm_Name')?.row.before).toBe('Avatar');
  });

  it('書き出し: 選んだ側で組み立てて作業ツリーへ書き、index は未マージのまま', async () => {
    await conflict('P.prefab', prefab('Player', '1'), prefab('Hero', '2'), prefab('Avatar', '3'));
    const session = await manager.open(dir);
    const view = await session.getUnityView('P.prefab', false);

    const { args } = await logged(() => session.resolveUnityConflict(view, new Map([['100', 'theirs']])));
    // 読み直し（指紋の照合）と書き込みだけ。git は 0 プロセス
    expect(args).toEqual(['read-worktree', 'write-conflict']);
    const written = await readFile(join(dir, 'P.prefab'), 'utf8');
    expect(written).toBe(prefab('Hero', '2'));
    expect(await unmerged(session, 'P.prefab')).toBe(true);

    // 書いた後はビューを作り直し、作業ツリーは「相手側と同じ」になる。前回の書き出しとして覚えている
    const again = await session.getUnityView('P.prefab', false);
    expect(again.conflict?.worktree).toBe('theirs');
    expect(session.isOwnUnityWrite(again)).toBe(true);
  });

  it('書き出し: 選び残しがあれば何も書かない', async () => {
    await conflict('P.prefab', prefab('Player', '1'), prefab('Hero', '2'), prefab('Avatar', '3'));
    const session = await manager.open(dir);
    const view = await session.getUnityView('P.prefab', false);
    const before = await readFile(join(dir, 'P.prefab'), 'utf8');

    await expect(session.resolveUnityConflict(view, new Map())).rejects.toBeInstanceOf(ConflictUnsupportedError);
    expect(await readFile(join(dir, 'P.prefab'), 'utf8')).toBe(before);
  });

  it('書き出し: ビューを作った後に作業ツリーが動いていたら書かない', async () => {
    await conflict('P.prefab', prefab('Player', '1'), prefab('Hero', '2'), prefab('Avatar', '3'));
    const session = await manager.open(dir);
    const view = await session.getUnityView('P.prefab', false);
    await writeFile(join(dir, 'P.prefab'), prefab('Edited', '5'));

    await expect(session.resolveUnityConflict(view, new Map([['100', 'ours']]))).rejects.toBeInstanceOf(StaleDiffError);
    expect(await readFile(join(dir, 'P.prefab'), 'utf8')).toBe(prefab('Edited', '5'));
  });

  it('マージをキャンセル（#51）: 確認が要り、マージ前に戻る', async () => {
    await conflict('P.prefab', prefab('Player', '1'), prefab('Hero', '2'), prefab('Avatar', '3'));
    const session = await manager.open(dir);
    expect(SessionOperations.confirmationFor('abortMerge')).toBe('abort-merge');

    await new SessionOperations(session).abortMerge();
    expect(await unmerged(session, 'P.prefab')).toBe(false);
    expect(await readFile(join(dir, 'P.prefab'), 'utf8')).toBe(prefab('Avatar', '3'));
  });

  it('マージをキャンセル（#51）: マージ中でなければ git が断る', async () => {
    await writeFile(join(dir, 'P.prefab'), prefab('Player', '1'));
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'base']);
    const session = await manager.open(dir);
    await expect(new SessionOperations(session).abortMerge()).rejects.toThrow();
  });
});
