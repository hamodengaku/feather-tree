import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { GitContext } from '../src/index.js';

/**
 * テスト用の使い捨てリポジトリ。
 *
 * CLAUDE.md 規約 2 により os.tmpdir() は使わず、リポジトリ内の .tmp/ 配下に作る。
 * ここで実行する git は「本リポジトリのソース管理」ではなく本アプリの検証対象。
 */
const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/git-tests');

export const GIT_PATH = process.env['FT_TEST_GIT'] ?? 'git';

export interface Fixture {
  readonly dir: string;
  readonly ctx: GitContext;
  run(...args: string[]): Promise<string>;
  write(relPath: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createFixture(): Promise<Fixture> {
  const dir = join(TEST_ROOT, randomBytes(8).toString('hex'));
  await mkdir(dir, { recursive: true });

  const fixture: Fixture = {
    dir,
    ctx: { gitPath: GIT_PATH, cwd: dir, tempDir: join(dir, '.ft-tmp') },
    run: (...args: string[]) => runRaw(dir, args),
    write: async (relPath: string, content: string) => {
      const target = join(dir, relPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    },
    cleanup: () => cleanupDir(dir),
  };

  // 検証用リポジトリの初期化。ユーザーの設定に影響されないよう明示的に指定する。
  await fixture.run('init', '--initial-branch=main');
  await fixture.run('config', 'user.name', 'FeatherTree Test');
  await fixture.run('config', 'user.email', 'test@example.invalid');
  await fixture.run('config', 'commit.gpgsign', 'false');
  await fixture.run('config', 'core.autocrlf', 'false');

  return fixture;
}

/**
 * 使い捨てリポジトリの削除。
 * Windows では git のプロセスやウイルス対策がハンドルを掴んでいて EBUSY / EPERM になることがある。
 * 数回リトライし、それでも消えなければ諦める（.tmp/ 配下なので残っても無害）。
 */
async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch {
      await new Promise((res) => setTimeout(res, 300));
    }
  }
}

/** 検証用リポジトリに対する生の git 実行。テストの前準備専用。 */
function runRaw(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(GIT_PATH, [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', rej);
    child.on('close', (code) => {
      if (code === 0) res(out);
      else rej(new Error(`git ${args.join(' ')} failed (${String(code)}): ${err}`));
    });
  });
}

export async function commitAll(fixture: Fixture, message: string): Promise<void> {
  await fixture.run('add', '-A');
  await fixture.run('commit', '-m', message);
}
