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

  it('git が PATH にあり wt.exe もあるなら、Windows ターミナルをリポジトリ直下で開く', async () => {
    const launch = await locateTerminal({
      env: { PATH: PATH_DIRS },
      cwd: CWD,
      gitPath: GIT,
      exists: only('C:/Program Files/Git/cmd/git.exe', 'C:/Windows/System32/wt.exe'),
    });

    expect(launch).toEqual({ exe: 'wt.exe', args: ['-d', CWD] });
  });

  it('wt.exe が無ければ powershell.exe に落とす', async () => {
    const launch = await locateTerminal({
      env: { PATH: PATH_DIRS },
      cwd: CWD,
      gitPath: GIT,
      exists: only('C:/Program Files/Git/cmd/git.exe'),
    });

    // cwd は spawn 側で与えるので引数は要らない
    expect(launch).toEqual({ exe: 'powershell.exe', args: [] });
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
