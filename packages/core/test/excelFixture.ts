import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { CommandLog, SessionManager, type AppSettings } from '../src/index.js';
import { buildXlsx, type BookSpec } from '../../excel/test/xlsxBuilder.js';
import { GIT_PATH, createFixture, type Fixture } from '../../git/test/fixture.js';

/*
 * Excel 差分・コンフリクトのテストの共通の前準備（core の excelConflict.test.ts・main の excelService.test.ts）。
 *
 * 使い捨てリポジトリは git 層のテストの fixture（.tmp/git-tests 配下。CLAUDE.md 規約 2）の上に作る。
 * ここで打つ git は本アプリの検証対象で、本リポジトリのソース管理ではない。
 */

export { GIT_PATH };

/** ブックを作る（deflate は Node の zlib）。 */
export const xlsx = (spec: BookSpec): Uint8Array => buildXlsx(spec, { deflate: (d) => deflateRawSync(d) });

export interface ExcelRepo {
  readonly dir: string;
  readonly log: CommandLog;
  /** 前準備の git（検証用リポジトリに対して）。 */
  git(...args: string[]): Promise<string>;
  /** 文字列またはバイト列をそのまま書く。 */
  write(rel: string, content: Uint8Array | string): Promise<void>;
  /** base → topic（相手側）と main（自分側）で書き換えて、マージで衝突させる。 */
  conflict(rel: string, base: Uint8Array | string, theirs: Uint8Array | string, ours: Uint8Array | string): Promise<void>;
  /** f の間に載った実行ログの先頭語（古い順）。 */
  logged<T>(f: () => Promise<T>): Promise<{ value: T; args: string[] }>;
  /** このリポジトリ用のセッション管理（一時ディレクトリはリポジトリの中）。 */
  sessions(settings: () => AppSettings): SessionManager;
  cleanup(): Promise<void>;
}

export async function createExcelRepo(): Promise<ExcelRepo> {
  const fx: Fixture = await createFixture();
  const log = new CommandLog();
  const write = (rel: string, content: Uint8Array | string): Promise<void> =>
    typeof content === 'string' ? fx.write(rel, content) : fx.writeBytes(rel, content);
  return {
    dir: fx.dir,
    log,
    git: (...args) => fx.run(...args),
    write,
    async conflict(rel, base, theirs, ours) {
      await write(rel, base);
      await fx.run('add', '-A');
      await fx.run('commit', '-m', 'base');
      await fx.run('switch', '-c', 'topic');
      await write(rel, theirs);
      await fx.run('commit', '-am', 'topic');
      await fx.run('switch', 'main');
      await write(rel, ours);
      await fx.run('commit', '-am', 'main');
      // 衝突で exit 1 になるのが正しい
      await fx.run('merge', 'topic').catch(() => undefined);
    },
    async logged(f) {
      const before = log.size;
      const value = await f();
      const count = log.size - before;
      const added = count === 0 ? [] : log.recent(count).reverse();
      return { value, args: added.map((e) => e.args[0] ?? '') };
    },
    sessions: (settings) => new SessionManager({ gitPath: GIT_PATH, tempDir: join(fx.dir, '.ft-tmp'), commandLog: log, settings }),
    cleanup: () => fx.cleanup(),
  };
}
