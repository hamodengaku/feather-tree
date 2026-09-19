import { describe, expect, it, vi } from 'vitest';
import { CommandLog } from '@feathertree/base-core';
import { GitCommandError } from '@feathertree/git';
import type * as GitModule from '@feathertree/git';
import { runClone } from '../../src/clone/cloneRunner.js';

const CRED_URL = 'https://user:TOKEN@host/repo.git';

/*
 * 脆弱性診断 §11: クローン URL に資格情報を埋め込んだ場合、生ログ・コマンドログに
 * 平文で残ってはならない。一方で、実際に git へ渡す URL（cloneRepository の引数）は
 * 変えてはいけない（伏せ字にしたら本来のクローンができなくなる）。
 *
 * cloneRepository だけをモックし、実際の git 実行はしない。
 */
vi.mock('@feathertree/git', async () => {
  const actual = await vi.importActual<typeof GitModule>('@feathertree/git');
  return {
    ...actual,
    cloneRepository: vi.fn(),
  };
});

async function importMockedCloneRepository() {
  const mod = await import('@feathertree/git');
  return mod.cloneRepository as unknown as ReturnType<typeof vi.fn>;
}

describe('runClone のログ・コマンドログは URL の資格情報を伏せる', () => {
  it('クローン成功時: 生ログの URL 行に TOKEN が出ない（実際の呼び出し引数は伏せない）', async () => {
    const cloneRepository = await importMockedCloneRepository();
    cloneRepository.mockResolvedValue({ code: 0, stderr: '', elapsedMs: 10 });

    const commandLog = new CommandLog();
    const result = await runClone(
      { url: CRED_URL, parentDir: 'D:/work', name: 'repo', mode: 'normal' },
      { gitPath: 'git', tempDir: 'D:/work/.tmp', commandLog },
      () => undefined,
    );

    expect(result.log).not.toContain('TOKEN');
    expect(result.log).toContain('https://***@host/repo.git');

    // コマンドログにも平文で残らない
    const entries = commandLog.recent();
    expect(entries.some((e) => e.args.some((a) => a.includes('TOKEN')))).toBe(false);

    // 実際に git へ渡した URL は伏せていない（cloneRepository への実引数）
    expect(cloneRepository).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ url: CRED_URL }),
      expect.anything(),
    );
  });

  it('クローン失敗時: git の stderr に URL が出ても、ヒント判定用の文字列・生ログに TOKEN が残らない', async () => {
    const cloneRepository = await importMockedCloneRepository();
    const stderr = `fatal: unable to access '${CRED_URL}/': The requested URL returned error: 403`;
    cloneRepository.mockRejectedValue(new GitCommandError(['clone'], 128, stderr));

    const commandLog = new CommandLog();
    const result = await runClone(
      { url: CRED_URL, parentDir: 'D:/work', name: 'repo', mode: 'normal' },
      { gitPath: 'git', tempDir: 'D:/work/.tmp', commandLog },
      () => undefined,
    );

    expect(result.result).toBe('failed');
    expect(result.log).not.toContain('TOKEN');

    const entries = commandLog.recent();
    expect(entries.some((e) => (e.stderr ?? '').includes('TOKEN'))).toBe(false);
    expect(entries.some((e) => e.args.some((a) => a.includes('TOKEN')))).toBe(false);
  });
});
