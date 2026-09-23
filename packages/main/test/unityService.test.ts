import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandLog, DEFAULT_SETTINGS, SessionManager, type AppSettings } from '@feathertree/core';
import { createService, type Service } from '../src/handlers/service.js';

/*
 * Unity モードの IPC ハンドラ（Phase 12 M4 / 決定 32）。
 *
 * 見るのは main の責務だけ——**パスの検証**と、
 * 「展開できないときも落ちずに理由を返す」こと。
 * 中身の正しさは unity 層と core の unityStage.test.ts で確かめてある。
 */

const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/main-unity-tests');
const GIT_PATH = process.env['FT_TEST_GIT'] ?? 'git';
const LF = String.fromCharCode(10);

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(GIT_PATH, [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', rej);
    child.on('close', (code) =>
      code === 0 ? res() : rej(new Error('git failed: ' + String(code))),
    );
  });
}

function prefab(scale: string): string {
  return [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!1 &100',
    'GameObject:',
    '  m_Component:',
    '  - component: {fileID: 101}',
    '  m_Name: Player',
    '--- !u!4 &101',
    'Transform:',
    '  m_GameObject: {fileID: 100}',
    '  m_LocalScale: {x: ' + scale + ', y: 1, z: 1}',
    '  m_Children: []',
    '  m_Father: {fileID: 0}',
    '',
  ].join(LF);
}

describe('Unity モードの IPC ハンドラ', () => {
  let dir: string;
  let service: Service;
  let settings: AppSettings;

  beforeEach(async () => {
    dir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(dir, { recursive: true });
    await git(dir, ['init', '--initial-branch=main']);
    await git(dir, ['config', 'user.name', 'T']);
    await git(dir, ['config', 'user.email', 't@example.invalid']);
    await git(dir, ['config', 'core.autocrlf', 'false']);

    settings = DEFAULT_SETTINGS;
    const commandLog = new CommandLog();
    const sessions = new SessionManager({
      gitPath: GIT_PATH,
      tempDir: join(dir, '.ft-tmp'),
      commandLog,
      settings: () => settings,
    });

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
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      () => undefined,
    );
  });

  async function write(rel: string, content: string): Promise<void> {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  async function openWithEdit(): Promise<string> {
    await write('Assets/Player.prefab', prefab('1'));
    await write('Assets/Script.cs', 'class A {}' + LF);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('Assets/Player.prefab', prefab('2.5'));
    return (await service.sessionOpen(dir)).id;
  }

  it('ヒエラルキーを返す。プロパティの表は含めない（DTO を小さく保つ）', async () => {
    const id = await openWithEdit();
    const view = await service.unityGetView(id, 'Assets/Player.prefab', false);

    expect(view.format).toBe('yaml');
    expect(view.stageable).toBe(true);
    expect(view.refusal).toBeNull();
    expect(view.nodes.map((n) => n.name)).toEqual(['Player', 'Transform']);
    expect(view.changedNodeCount).toBe(1);
    // 表は入っていない
    expect(JSON.stringify(view)).not.toContain('m_LocalScale');
  });

  it('変更のある節までの経路に hasChangedDescendant が立つ（要件 7 の自動展開）', async () => {
    const id = await openWithEdit();
    const view = await service.unityGetView(id, 'Assets/Player.prefab', false);
    expect(view.nodes[0]).toMatchObject({ name: 'Player', hasChangedDescendant: true });
    expect(view.nodes[1]).toMatchObject({ name: 'Transform', mark: 'changed' });
  });

  it('選んだノードの表と、ステージの座標を返す', async () => {
    const id = await openWithEdit();
    const detail = await service.unityGetNode(id, 'Assets/Player.prefab', false, '101');
    expect(detail).not.toBeNull();

    const scale = detail?.rows.find((r) => r.key === 'm_LocalScale.x');
    expect(scale).toMatchObject({ state: 'changed', before: '1', after: '2.5' });
    expect(scale?.selection).not.toBeNull();

    // 変わっていない行にはボタンを出さない（要件 13）
    const same = detail?.rows.find((r) => r.key === 'm_LocalScale.y');
    expect(same?.state).toBe('same');
    expect(same?.selection).toBeNull();

    // ノード全体（「コンポーネントをステージ」）の座標も付く
    expect(detail?.selection).not.toBeNull();
  });

  it('同じ行に乗る変更の数を添える（押す前に分かるように）', async () => {
    await write('Assets/Player.prefab', prefab('1'));
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    // x と y の両方を変える。1 行なので片方だけは入れられない
    await write(
      'Assets/Player.prefab',
      prefab('1').replace('{x: 1, y: 1, z: 1}', '{x: 2, y: 3, z: 1}'),
    );
    const id = (await service.sessionOpen(dir)).id;

    const detail = await service.unityGetNode(id, 'Assets/Player.prefab', false, '101');
    const x = detail?.rows.find((r) => r.key === 'm_LocalScale.x');
    expect(x?.state).toBe('changed');
    expect(x?.alsoStages).toBe(1);
  });

  it('知らないノード id には null を返す', async () => {
    const id = await openWithEdit();
    expect(await service.unityGetNode(id, 'Assets/Player.prefab', false, '999')).toBeNull();
  });

  it('.prefab / .unity 以外は not-prefab（エラーにはしない）', async () => {
    const id = await openWithEdit();
    const view = await service.unityGetView(id, 'Assets/Script.cs', false);
    expect(view.format).toBe('not-prefab');
    expect(view.nodes).toHaveLength(0);
    expect(view.stageable).toBe(false);
  });

  it('バイナリシリアライズの .prefab は binary（展開できません）', async () => {
    await write('Assets/Bin.prefab', 'UnityFS' + String.fromCharCode(0) + 'binary');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('Assets/Bin.prefab', 'UnityFS' + String.fromCharCode(0) + 'changed');
    const id = (await service.sessionOpen(dir)).id;

    const view = await service.unityGetView(id, 'Assets/Bin.prefab', false);
    expect(view.format).toBe('binary');
    expect(view.stageable).toBe(false);
  });

  it('LFS のポインタも binary に倒す（中身がファイル本体ではない）', async () => {
    const pointer = [
      'version https://git-lfs.github.com/spec/v1',
      'oid sha256:0000000000000000000000000000000000000000000000000000000000000000',
      'size 12345',
      '',
    ].join(LF);
    await write('Assets/Lfs.prefab', pointer);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('Assets/Lfs.prefab', pointer.replace('12345', '99999'));
    const id = (await service.sessionOpen(dir)).id;

    expect((await service.unityGetView(id, 'Assets/Lfs.prefab', false)).format).toBe('binary');
  });

  it('新規ファイル（未追跡）は表示できるがステージはできない', async () => {
    await write('Assets/Keep.txt', 'x');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('Assets/New.prefab', prefab('1'));
    const id = (await service.sessionOpen(dir)).id;

    const view = await service.unityGetView(id, 'Assets/New.prefab', false);
    expect(view.format).toBe('yaml');
    // 全ノードが追加として見える
    expect(view.nodes.every((n) => n.mark === 'added')).toBe(true);
    // 未追跡の合成 diff からはパッチを作れない（A-5）
    expect(view.stageable).toBe(false);
    expect(view.refusal).toBe('synthesized');
  });

  it('索引を作るとスクリプト名が名前に入る（要件 11。git は 0 プロセス）', async () => {
    const guid = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const withScript = (enabled: string): string =>
      [
        '%YAML 1.1',
        '%TAG !u! tag:unity3d.com,2011:',
        '--- !u!1 &100',
        'GameObject:',
        '  m_Component:',
        '  - component: {fileID: 102}',
        '  m_Name: Player',
        '--- !u!114 &102',
        'MonoBehaviour:',
        '  m_GameObject: {fileID: 100}',
        '  m_Enabled: ' + enabled,
        '  m_Script: {fileID: 11500000, guid: ' + guid + ', type: 3}',
        '',
      ].join(LF);

    await write('Assets/Player.prefab', withScript('1'));
    await write('Assets/Scripts/WeaponController.cs', 'class A {}' + LF);
    await write(
      'Assets/Scripts/WeaponController.cs.meta',
      ['fileFormatVersion: 2', 'guid: ' + guid, ''].join(LF),
    );
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('Assets/Player.prefab', withScript('0'));
    const id = (await service.sessionOpen(dir)).id;

    // 索引を作る前は guid の先頭 8 桁
    const before = await service.unityGetView(id, 'Assets/Player.prefab', false);
    expect(before.nodes.map((n) => n.name)).toContain('MonoBehaviour (a1b2c3d4)');

    const indexed = await service.unityIndexScripts(id);
    expect(indexed.resolved).toBe(1);

    // 索引の後はスクリプト名（ビューは作り直される）
    const after = await service.unityGetView(id, 'Assets/Player.prefab', false);
    expect(after.nodes.map((n) => n.name)).toContain('WeaponController');
  });

  it('索引は 1 度だけ作り、2 度目は走査しない', async () => {
    const id = await openWithEdit();
    await service.unityIndexScripts(id);
    const first = service.commandLogRecent(50).filter((e) => e.args[0] === 'scan-meta').length;
    await service.unityIndexScripts(id);
    const second = service.commandLogRecent(50).filter((e) => e.args[0] === 'scan-meta').length;
    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  it('リポジトリ外のパスは拒否する', async () => {
    const id = await openWithEdit();
    const outside = '..' + String.fromCharCode(47) + 'outside.prefab';
    await expect(service.unityGetView(id, outside, false)).rejects.toThrow();
    await expect(service.unityGetNode(id, outside, false, '100')).rejects.toThrow();
  });

  it('知らないセッションは拒否する', async () => {
    await expect(service.unityGetView('nope', 'Assets/Player.prefab', false)).rejects.toThrow();
  });

  it('#48 と diff が実行ログに残る（実行ログに出ない git を作らない）', async () => {
    const id = await openWithEdit();
    await service.unityGetView(id, 'Assets/Player.prefab', false);
    const logged = service.commandLogRecent(50).map((e) => e.args.join(' '));
    expect(logged.some((a) => a.startsWith('show '))).toBe(true);
    expect(logged.some((a) => a.startsWith('read-worktree '))).toBe(true);
  });

  /*
   * 対応表「複数プロセスを許可する例外」の実測。
   * 未ステージは #48（index）→ #18 の **2 プロセス**（新側は fs 読みで git 0）。
   * ステージ済みは #48（HEAD）→ #48（index）→ #19 の **3 プロセス**。
   * ここが増えていたら、表に書いていない git がどこかで走っている。
   */
  it('ファイルを選ぶときの git プロセス数が対応表どおり', async () => {
    const id = await openWithEdit();
    const before = service.commandLogRecent(200).length;

    await service.unityGetView(id, 'Assets/Player.prefab', false);
    const unstaged = service
      .commandLogRecent(200)
      .slice(0, service.commandLogRecent(200).length - before)
      .map((e) => e.args[0]);

    // read-worktree は git を起動しない（ログには出るがプロセスではない）
    expect(unstaged.filter((a) => a !== 'read-worktree')).toEqual(['diff', 'show']);
  });

  it('ステージ済みを選ぶと #48 が 2 回（旧＝HEAD・新＝index）', async () => {
    await write('Assets/Player.prefab', prefab('1'));
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await write('Assets/Player.prefab', prefab('2.5'));
    await git(dir, ['add', 'Assets/Player.prefab']);
    const id = (await service.sessionOpen(dir)).id;
    const before = service.commandLogRecent(200).length;

    await service.unityGetView(id, 'Assets/Player.prefab', true);
    const staged = service
      .commandLogRecent(200)
      .slice(0, service.commandLogRecent(200).length - before)
      .map((e) => e.args[0]);

    expect(staged.filter((a) => a === 'show')).toHaveLength(2);
    expect(staged.filter((a) => a === 'diff')).toHaveLength(1);
    expect(staged).not.toContain('read-worktree');
  });

  it('同じファイルを選び直しても git を増やさない（キャッシュが効く）', async () => {
    const id = await openWithEdit();
    await service.unityGetView(id, 'Assets/Player.prefab', false);
    const after = service.commandLogRecent(200).length;

    await service.unityGetView(id, 'Assets/Player.prefab', false);
    await service.unityGetNode(id, 'Assets/Player.prefab', false, '101');
    expect(service.commandLogRecent(200)).toHaveLength(after);
  });
});
