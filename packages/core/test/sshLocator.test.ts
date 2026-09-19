import { describe, expect, it } from 'vitest';
import { findOnPath, locateSsh } from '../src/index.js';

/*
 * `GIT_SSH_COMMAND` に埋める ssh の解決（決定 13 の追記、診断 1-A / 1-B）。
 *
 * **要点は「bare 名を返さない」こと。** 実在判定はテストから差し替え、
 * 開発機に何が入っているかで結果が変わらないようにする（gitLocator のテストと同じ流儀）。
 */
const SEP = process.platform === 'win32' ? ';' : ':';
const SSH = process.platform === 'win32' ? 'ssh.exe' : 'ssh';

/** 指定したパスだけが存在することにする。 */
const only = (...paths: readonly string[]) => (p: string) => Promise.resolve(paths.includes(p));

describe('ssh の解決', () => {
  it('PATH にあればその絶対パスを返す（今までシェルが選んでいたものと同じ）', async () => {
    const found = await locateSsh({
      env: { PATH: ['C:\\tools', 'C:\\other'].join(SEP) },
      gitPath: null,
      exists: only('C:\\tools\\' + SSH),
    });
    expect(found).toBe('C:\\tools\\' + SSH);
  });

  it('PATH の相対パス要素は候補にしない（cwd の同名ファイルを拾わせない。1-A）', async () => {
    const found = await locateSsh({
      env: { PATH: ['.', 'relative\\dir'].join(SEP) },
      gitPath: null,
      // 相対要素から組み立てた候補が「存在する」と答えても拾ってはいけない
      exists: () => Promise.resolve(true),
    });
    // PATH からは拾わず、次の候補（Windows OpenSSH）へ落ちる
    expect(found).not.toBe('.\\' + SSH);
    expect(found).not.toBe('relative\\dir\\' + SSH);
  });

  it('PATH に無ければ Windows の OpenSSH を使う', async () => {
    if (process.platform !== 'win32') return;
    const found = await locateSsh({
      env: { PATH: 'C:\\tools', SystemRoot: 'C:\\Windows' },
      gitPath: null,
      exists: only('C:\\Windows\\System32\\OpenSSH\\ssh.exe'),
    });
    expect(found).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe');
  });

  it('最後の手段として Git 同梱の ssh を git.exe のパスから導く', async () => {
    const bundled = 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe';
    const found = await locateSsh({
      env: { PATH: 'C:\\tools', SystemRoot: 'C:\\Windows' },
      gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
      exists: only(bundled),
    });
    expect(found).toBe(bundled);
  });

  it('どこにも無ければ null（＝何も注入しない。git の既定に任せる）', async () => {
    const found = await locateSsh({
      env: { PATH: 'C:\\tools', SystemRoot: 'C:\\Windows' },
      gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
      exists: () => Promise.resolve(false),
    });
    expect(found).toBeNull();
  });

  it('git が未検出でも落ちない', async () => {
    const found = await locateSsh({ env: {}, gitPath: null, exists: () => Promise.resolve(false) });
    expect(found).toBeNull();
  });
});

describe('PATH 探索の共通規則', () => {
  it('絶対パス要素だけを見て、絶対パスを返す', async () => {
    const found = await findOnPath(
      ['x.exe'],
      { PATH: ['.', 'rel', 'C:\\abs'].join(SEP) },
      only('.\\x.exe', 'rel\\x.exe', 'C:\\abs\\x.exe'),
    );
    expect(found).toBe('C:\\abs\\x.exe');
  });

  it('引用符で囲まれた PATH 要素を剥がす', async () => {
    const found = await findOnPath(['x.exe'], { PATH: '"C:\\abs"' }, only('C:\\abs\\x.exe'));
    expect(found).toBe('C:\\abs\\x.exe');
  });

  it('PATH が無ければ null', async () => {
    expect(await findOnPath(['x.exe'], {}, () => Promise.resolve(true))).toBeNull();
  });
});
