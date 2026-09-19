import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandFor } from '../src/index.js';
import type { GitContext } from '../src/index.js';

const COMMANDS_DIR = resolve(import.meta.dirname, '../src/commands');

/**
 * GitCommand の組み立てが 1 箇所に寄っていることを機械的に検出する。
 *
 * 文脈（GitContext）に項目が増えたとき、**足し忘れた実装だけが静かに古い挙動のまま**になる。
 * 実際に `GIT_SSH_COMMAND` を通すために `env` を足したときがそれで、22 箇所のうち
 * 1 つでも直書きが残っていると「その操作でだけ鍵が効かない」という追いにくい壊れ方をする。
 *
 * completeness.test.ts / layers.test.ts と同じ「静的な取りこぼし検出」の仲間。
 */
describe('GitCommand の組み立て口', () => {
  const sources = readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ name: f, text: readFileSync(resolve(COMMANDS_DIR, f), 'utf8') }));

  it('検査対象のコマンド実装が揃っている（検出漏れした状態で緑にならないこと）', () => {
    expect(sources.length).toBeGreaterThanOrEqual(10);
  });

  it('commands/ は GitCommand を直接組み立てない（commandFor を通す）', () => {
    const violations: string[] = [];
    for (const { name, text } of sources) {
      // context.ts は GitContext の宣言そのもの。
      // repository.ts の getGitVersion は GitContext を持たない起動時の 1 回きり（#32）で、
      // ssh も一時ファイルも関係しないため対象外。
      if (name === 'context.ts') continue;
      for (const line of text.split('\n')) {
        if (!line.includes('gitPath:')) continue;
        if (line.includes('getGitVersion(gitPath: string')) continue;
        violations.push(`${name}: ${line.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('commandFor の合成', () => {
  const ctx = (env?: Readonly<Record<string, string>>): GitContext => ({
    gitPath: 'C:/git/git.exe',
    cwd: 'C:/repo',
    tempDir: 'C:/tmp',
    ...(env === undefined ? {} : { env }),
  });

  it('文脈に env が無ければ env を付けない', () => {
    expect(commandFor(ctx(), ['status'])).toEqual({
      gitPath: 'C:/git/git.exe',
      cwd: 'C:/repo',
      args: ['status'],
    });
  });

  it('文脈の env をそのまま載せる', () => {
    const cmd = commandFor(ctx({ GIT_SSH_COMMAND: "ssh -i 'k'" }), ['fetch']);
    expect(cmd.env).toEqual({ GIT_SSH_COMMAND: "ssh -i 'k'" });
  });

  it('コマンド固有の env と混ぜる（両方が載る）', () => {
    const cmd = commandFor(ctx({ GIT_SSH_COMMAND: "ssh -i 'k'" }), ['clone'], {
      env: { GIT_LFS_SKIP_SMUDGE: '1' },
    });
    expect(cmd.env).toEqual({ GIT_SSH_COMMAND: "ssh -i 'k'", GIT_LFS_SKIP_SMUDGE: '1' });
  });

  it('同じキーならコマンド固有の方が勝つ', () => {
    const cmd = commandFor(ctx({ GIT_LFS_SKIP_SMUDGE: '0' }), ['clone'], {
      env: { GIT_LFS_SKIP_SMUDGE: '1' },
    });
    expect(cmd.env).toEqual({ GIT_LFS_SKIP_SMUDGE: '1' });
  });

  /*
   * タイムアウトも同じ口から載せる（docs/02-git-command-map.md キャンセル・タイムアウト節）。
   * 渡さないときに timeoutMs が**生えない**ことまで見るのは、書き込み系・通信系に
   * 既定値が紛れ込むと「人が待つと決めた操作」が途中で切られるため。
   * どのコマンドに何秒載るかは commandTimeouts.test.ts が別に見ている。
   */
  it('timeoutMs を渡さなければ載らない', () => {
    expect(commandFor(ctx(), ['push']).timeoutMs).toBeUndefined();
  });

  it('timeoutMs を渡せば載る（env とは独立）', () => {
    expect(commandFor(ctx(), ['status'], { timeoutMs: 300_000 })).toEqual({
      gitPath: 'C:/git/git.exe',
      cwd: 'C:/repo',
      args: ['status'],
      timeoutMs: 300_000,
    });
  });
});
