import { describe, expect, it } from 'vitest';
import { locateTerminal } from '../src/index.js';

/*
 * 「ターミナルで開く」の起動先の決め方（決定 26）。
 *
 * 要件は「Windows ターミナルを出す」ではなく「**git が通るターミナルを出す**」。
 * 実在するファイルを見に行かせないよう exists を注入するので、
 * この検証は開発機に何が入っているかに左右されない。
 */
describe('locateTerminal (決定 26)', () => {
  const CWD = 'D:/repo';
  const GIT = 'C:/Program Files/Git/cmd/git.exe';

  /**
   * ここに挙げたパスだけが存在することにする。
   * path.join は Windows では  を返すので、区切りと大小文字を均してから比べる。
   */
  const norm = (p: string): string =>
    p.split(String.fromCharCode(92)).join('/').toLowerCase();

  function only(...paths: readonly string[]): (path: string) => Promise<boolean> {
    const set = new Set(paths.map(norm));
    return (path) => Promise.resolve(set.has(norm(path)));
  }

  const PATH_DIRS = 'C:/Windows/System32;C:/Program Files/Git/cmd';
  const POWERSHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

  it('git が PATH にあり wt.exe もあるなら、PATH 上で見つかった wt.exe の絶対パスをリポジトリ直下で開く', async () => {
    const launch = await locateTerminal({
      env: { PATH: PATH_DIRS },
      cwd: CWD,
      gitPath: GIT,
      exists: only('C:/Program Files/Git/cmd/git.exe', 'C:/Windows/System32/wt.exe'),
    });

    // 'wt.exe' という bare 名ではなく、PATH 探索で見つかった絶対パスを返す（1-A）。
    // path.join は Windows では区切りをバックスラッシュに正規化するので、比較前に均す。
    expect(norm(launch?.exe ?? '')).toBe('c:/windows/system32/wt.exe');
    expect(launch?.args).toEqual(['-d', CWD]);
  });

  it('wt.exe が無ければ、%SystemRoot% から組み立てた powershell.exe の絶対パスに落とす', async () => {
    const launch = await locateTerminal({
      env: { PATH: PATH_DIRS, SystemRoot: 'C:/Windows' },
      cwd: CWD,
      gitPath: GIT,
      exists: only('C:/Program Files/Git/cmd/git.exe', POWERSHELL),
    });

    // cwd は spawn 側で与えるので引数は要らない。exe は bare 名 'powershell.exe' ではなく絶対パス
    expect(norm(launch?.exe ?? '')).toBe(norm(POWERSHELL));
    expect(launch?.args).toEqual([]);
  });

  it('PATH に相対パス要素や "." が混ざっていても無視する（cwd 検索と同種の穴を PATH 側に作らない）', async () => {
    const launch = await locateTerminal({
      env: { PATH: '.;relative/dir;C:/Windows/System32', SystemRoot: 'C:/Windows' },
      cwd: CWD,
      gitPath: GIT,
      // '.' や 'relative/dir' 配下にも wt.exe があることにするが、これは拾ってはならない
      exists: only('C:/Windows/System32/git.exe', './wt.exe', 'relative/dir/wt.exe', POWERSHELL),
    });

    // wt.exe は絶対パス側から見つからないので powershell に落ちる
    expect(norm(launch?.exe ?? '')).toBe(norm(POWERSHELL));
    expect(launch?.args).toEqual([]);
  });

  it('リポジトリ直下に wt.exe があっても、PATH 上の絶対パスが優先される（cwd 検索の乗っ取り対策）', async () => {
    const launch = await locateTerminal({
      env: { PATH: PATH_DIRS },
      cwd: CWD,
      gitPath: GIT,
      // CWD 配下（D:/repo/wt.exe）にも wt.exe を用意するが、これは exists の対象にしない
      // （findOnPath は PATH のディレクトリしか見ないため、そもそも候補にならないことを確認する）
      exists: only('C:/Program Files/Git/cmd/git.exe', 'C:/Windows/System32/wt.exe', 'D:/repo/wt.exe'),
    });

    expect(norm(launch?.exe ?? '')).toBe('c:/windows/system32/wt.exe');
    expect(launch?.args).toEqual(['-d', CWD]);
  });

  it('powershell.exe が絶対パスにも存在しなければ Git Bash に落とす', async () => {
    const launch = await locateTerminal({
      env: { PATH: PATH_DIRS, SystemRoot: 'C:/Windows' },
      cwd: CWD,
      gitPath: GIT,
      exists: only('C:/Program Files/Git/cmd/git.exe', 'C:/Program Files/Git/git-bash.exe'),
    });

    expect(norm(launch?.exe ?? '')).toBe('c:/program files/git/git-bash.exe');
  });

  it('git が PATH に無ければ、wt.exe があっても Git Bash を開く', async () => {
    const launch = await locateTerminal({
      env: { PATH: 'C:/Windows/System32' },
      cwd: CWD,
      gitPath: GIT,
      exists: only('C:/Windows/System32/wt.exe', 'C:/Program Files/Git/git-bash.exe'),
    });

    expect(norm(launch?.exe ?? '')).toBe('c:/program files/git/git-bash.exe');
  });

  it('git が PATH に無く Git Bash も無ければ null（呼び出し側がエラーを出す）', async () => {
    const launch = await locateTerminal({
      env: { PATH: 'C:/Windows/System32' },
      cwd: CWD,
      gitPath: GIT,
      exists: only('C:/Windows/System32/wt.exe'),
    });

    expect(launch).toBeNull();
  });

  it('git がそもそも見つかっていなければ null', async () => {
    const launch = await locateTerminal({
      env: { PATH: 'C:/Windows/System32' },
      cwd: CWD,
      gitPath: null,
      exists: only('C:/Windows/System32/wt.exe'),
    });

    expect(launch).toBeNull();
  });

  it('PATH が空でも落ちない', async () => {
    const launch = await locateTerminal({
      env: {},
      cwd: CWD,
      gitPath: GIT,
      exists: only('C:/Program Files/Git/git-bash.exe'),
    });

    expect(launch?.args).toEqual([]);
  });
});
