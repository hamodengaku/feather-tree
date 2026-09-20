import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandLog,
  DEFAULT_SETTINGS,
  SessionManager,
  SessionOperations,
  StaleStashError,
  supportsStagedStash,
  validateStashMessage,
} from '../src/index.js';

const TEST_ROOT = resolve(import.meta.dirname, '../../../.tmp/core-stash-tests');
const GIT_PATH = process.env['FT_TEST_GIT'] ?? 'git';
const LF = String.fromCharCode(10);
const US = String.fromCharCode(0x1f);

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(GIT_PATH, [...args], { cwd, shell: false, windowsHide: true, stdio: 'ignore' });
    child.on('error', rej);
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`git failed: ${String(code)}`))));
  });
}

describe('SessionOperations の stash 操作 (対応表 #27〜#31、決定 31)', () => {
  let dir: string;
  let manager: SessionManager;
  /** 実行された git を数えるため（「揃え直しの git を打たない」の検証）。 */
  let commandLog: CommandLog;

  beforeEach(async () => {
    dir = join(TEST_ROOT, randomBytes(8).toString('hex'));
    await mkdir(dir, { recursive: true });
    await git(dir, ['init', '--initial-branch=main']);
    await git(dir, ['config', 'user.name', 'T']);
    await git(dir, ['config', 'user.email', 't@example.invalid']);
    await git(dir, ['config', 'core.autocrlf', 'false']);

    commandLog = new CommandLog();
    manager = new SessionManager({
      gitPath: GIT_PATH,
      tempDir: join(dir, '.ft-tmp'),
      commandLog,
      settings: () => DEFAULT_SETTINGS,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });

  async function write(rel: string, content: string): Promise<void> {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  /** 初期コミットを作り、セッションを開く。 */
  async function open(): Promise<{ session: Awaited<ReturnType<SessionManager['open']>>; ops: SessionOperations }> {
    await write('a.txt', ['1', '2', '3', '4', '5', '6', '7', '8'].join(LF) + LF);
    await write('b.txt', 'b' + LF);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);

    const session = await manager.open(dir);
    return { session, ops: new SessionOperations(session) };
  }

  it('ステージしたものだけが退避され、結果に取り直した一覧が載る', async () => {
    const { session, ops } = await open();

    await write('a.txt', ['1', 'STAGED', '3', '4', '5', '6', '7', '8'].join(LF) + LF);
    await write('b.txt', 'b の未ステージ変更' + LF);
    await git(dir, ['add', 'a.txt']);
    await session.refreshStatus();

    const before = session.statusSeq;
    const outcome = await ops.saveStash('退避のメモ');

    expect(outcome.stashes).toHaveLength(1);
    expect(outcome.stashes[0]?.message).toContain('退避のメモ');
    // status は必ず取り直す（対応表の例外「#27 → #2 → #28」）
    expect(outcome.statusSeq).toBeGreaterThan(before);

    // ステージ分だけが作業ツリーから消え、未ステージ分は残る
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).not.toContain('STAGED');
    expect(await readFile(join(dir, 'b.txt'), 'utf8')).toContain('未ステージ変更');
  });

  /*
   * docs/02-git-command-map.md #27 の実測表 5 行目。
   * **失敗しても status を取り直す**のが要で、取り直さないと
   * 「エラーが出たのに stash が増えている」状態が画面に出ない。
   */
  it('失敗しても status は取り直す（stash だけができている場合があるため）', async () => {
    const { session, ops } = await open();

    await write('near.txt', ['x', 'y', 'z'].join(LF) + LF);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'near']);
    await write('near.txt', ['x', 'Y', 'z'].join(LF) + LF);
    await git(dir, ['add', 'near.txt']);
    await write('near.txt', ['x', 'Y', 'Z'].join(LF) + LF);
    await session.refreshStatus();

    const before = session.statusSeq;
    await expect(ops.saveStash('近接する変更')).rejects.toThrow();

    expect(session.statusSeq).toBeGreaterThan(before);
    // git 側では stash が積まれている
    expect(await session.listStashes()).toHaveLength(1);
  });

  it('展開すると作業ツリーへ戻り、pop なら一覧から消える', async () => {
    const { session, ops } = await open();

    await write('a.txt', ['退避した内容'].join(LF) + LF);
    await git(dir, ['add', 'a.txt']);
    await session.refreshStatus();
    const saved = await ops.saveStash('あとで戻す');
    const entry = saved.stashes[0];
    expect(entry).toBeDefined();

    const popped = await ops.applyStash({ index: entry?.index ?? 0, oid: entry?.oid ?? '' }, true);

    expect(popped.stashes).toHaveLength(0);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toContain('退避した内容');
  });

  /*
   * 決定 31 の追記。素の git は新規ファイルだけをステージ済み（`A.`）で戻すので、
   * そこだけ揃わない。展開の直後に #6 を打って未ステージへ揃える。
   */
  it('展開した差分はすべて未ステージになる（新規ファイルも）', async () => {
    const { session, ops } = await open();

    await write('a.txt', ['1', '2', '3', '変更した'].join(LF) + LF); // 変更
    await write('new.txt', '新規' + LF); // 新規
    await git(dir, ['rm', '-q', 'b.txt']); // 削除
    await git(dir, ['add', '-A']);
    await session.refreshStatus();

    const saved = await ops.saveStash('3 種類を混ぜる');
    const entry = saved.stashes[0];

    await ops.applyStash({ index: entry?.index ?? 0, oid: entry?.oid ?? '' }, true);

    // ステージ済みは 1 件も残らない
    expect(session.getStatusSummary().counts.staged).toBe(0);
    // 中身は戻っている（新規ファイルは未追跡として現れる）
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toContain('変更した');
    expect(await readFile(join(dir, 'new.txt'), 'utf8')).toContain('新規');
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
  });

  /*
   * 揃え直しの対象は「その展開で新しくステージ済みになった分」だけ。
   * 全ステージ済みを戻すと、**利用者が展開前から積んでいた作業**を巻き戻してしまう。
   */
  it('展開の前から利用者がステージしていた分は巻き添えにしない', async () => {
    const { session, ops } = await open();

    await write('a.txt', '退避する' + LF);
    await git(dir, ['add', 'a.txt']);
    await session.refreshStatus();
    const saved = await ops.saveStash('退避');
    const entry = saved.stashes[0];

    // 展開の前に、利用者が別のファイルを自分でステージしておく
    await write('b.txt', '自分でステージした' + LF);
    await git(dir, ['add', 'b.txt']);
    await session.refreshStatus();

    await ops.applyStash({ index: entry?.index ?? 0, oid: entry?.oid ?? '' }, true);

    // b.txt のステージは残り、展開した a.txt は未ステージ
    const snapshot = session.snapshot;
    const staged = (snapshot?.entries ?? []).filter((e) => e.staged !== '.').map((e) => e.path);
    expect(staged).toEqual(['b.txt']);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toContain('退避する');
  });

  it('変更だけの stash では、揃え直しの git を打たない', async () => {
    const { session, ops } = await open();

    await write('a.txt', '変更だけ' + LF);
    await git(dir, ['add', 'a.txt']);
    await session.refreshStatus();
    const saved = await ops.saveStash('変更だけ');
    const entry = saved.stashes[0];

    const before = commandLog.recent(500).length;
    await ops.applyStash({ index: entry?.index ?? 0, oid: entry?.oid ?? '' }, true);
    const labels = commandLog
      .recent(500)
      .slice(0, commandLog.recent(500).length - before)
      .map((e) => e.args.join(' '));

    // 新しくステージ済みになったものが無いので restore は打たれない
    expect(labels.some((l) => l.startsWith('restore'))).toBe(false);
    expect(session.getStatusSummary().counts.staged).toBe(0);
  });

  it('apply は一覧を取り直さずに、照合で取った一覧をそのまま返す', async () => {
    const { session, ops } = await open();

    await write('a.txt', '適用して残す' + LF);
    await git(dir, ['add', 'a.txt']);
    await session.refreshStatus();
    const saved = await ops.saveStash('残す');
    const entry = saved.stashes[0];

    const applied = await ops.applyStash({ index: entry?.index ?? 0, oid: entry?.oid ?? '' }, false);

    expect(applied.stashes).toHaveLength(1);
    expect(applied.stashes[0]?.oid).toBe(entry?.oid);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toContain('適用して残す');
  });

  it('破棄は指定の 1 件だけを消し、作業ツリーには触れない', async () => {
    const { session, ops } = await open();

    for (const name of ['古い', '新しい']) {
      await write('a.txt', name + LF);
      await git(dir, ['add', 'a.txt']);
      await session.refreshStatus();
      await ops.saveStash(name);
    }
    await write('untouched.txt', '残るファイル' + LF);

    const list = await session.listStashes();
    const newest = list[0];
    expect(newest?.message).toContain('新しい');

    const after = await ops.dropStash({ index: newest?.index ?? 0, oid: newest?.oid ?? '' });

    expect(after.stashes).toHaveLength(1);
    expect(after.stashes[0]?.message).toContain('古い');
    expect(existsSync(join(dir, 'untouched.txt'))).toBe(true);
  });

  /*
   * 決定 31 の要。番号は drop / pop のたびにずれるので、一覧が古いまま打つと
   * **別の stash を消す**。打つ直前に #28 を取り直して oid を照合する。
   */
  describe('打つ直前の照合（別の stash を消さないための門）', () => {
    it('番号は合っていても oid が違えば、git を打たずに断る', async () => {
      const { session, ops } = await open();

      for (const name of ['古い', '新しい']) {
        await write('a.txt', name + LF);
        await git(dir, ['add', 'a.txt']);
        await session.refreshStatus();
        await ops.saveStash(name);
      }

      const stale = await session.listStashes();
      const target = stale[1];
      expect(target?.message).toContain('古い');

      // 表示してから、別の経路（ターミナル）で 0 番が落ちて番号がずれた
      await git(dir, ['stash', 'drop', 'stash@{0}']);

      await expect(
        ops.dropStash({ index: target?.index ?? 1, oid: target?.oid ?? '' }),
      ).rejects.toBeInstanceOf(StaleStashError);

      // 1 件も消えていない（ずれた先の stash を巻き添えにしていない）
      const survived = await session.listStashes();
      expect(survived).toHaveLength(1);
      expect(survived[0]?.message).toContain('古い');
    });

    it('存在しない番号も同じ門で断る', async () => {
      const { ops } = await open();
      await expect(ops.dropStash({ index: 3, oid: 'a'.repeat(40) })).rejects.toBeInstanceOf(
        StaleStashError,
      );
    });

    it('負の番号は git を 1 回も打たずに断る', async () => {
      const { ops } = await open();
      await expect(ops.applyStash({ index: -1, oid: 'a'.repeat(40) }, true)).rejects.toBeInstanceOf(
        StaleStashError,
      );
    });
  });

  it('破棄だけが確認を要する（決定 16）', () => {
    expect(SessionOperations.confirmationFor('stashDrop')).toBe('stash-drop');
    expect(SessionOperations.confirmationFor('stashSave')).toBeNull();
    expect(SessionOperations.confirmationFor('stashApply')).toBeNull();
  });
});

describe('stash メッセージの検証 (policy/stashMessage.ts)', () => {
  it('前後の空白を落として通す', () => {
    expect(validateStashMessage('  退避のメモ  ')).toEqual({ ok: true, value: '退避のメモ' });
  });

  it('空は断る（無題の stash は一覧で見分けられない）', () => {
    expect(validateStashMessage('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  /*
   * US（0x1f）は `%gs` をそのまま通る（実測）。通すと #28 のフィールドがずれるので、
   * ここが実質の唯一の防壁になる。
   */
  it('改行・US などの制御文字を断る', () => {
    expect(validateStashMessage('a' + LF + 'b')).toEqual({ ok: false, reason: 'control-char' });
    expect(validateStashMessage('a' + US + 'b')).toEqual({ ok: false, reason: 'control-char' });
  });

  it('長すぎるものを断る', () => {
    expect(validateStashMessage('あ'.repeat(256))).toEqual({ ok: false, reason: 'too-long' });
  });

  /*
   * `--message=<msg>` は 1 引数なので、先頭 `-` でもオプションにならない。
   * 理由の無い制限を足さない（素の git に近づける）。
   */
  it('先頭が - でも通す', () => {
    expect(validateStashMessage('-x で始まるメモ')).toEqual({ ok: true, value: '-x で始まるメモ' });
  });
});

describe('supportsStagedStash (対応表 #27 / 決定 31)', () => {
  const v = (major: number, minor: number) => ({ raw: '', major, minor, patch: 0 });

  it('2.35 以降なら使える', () => {
    expect(supportsStagedStash(v(2, 35))).toBe(true);
    expect(supportsStagedStash(v(2, 40))).toBe(true);
    expect(supportsStagedStash(v(3, 0))).toBe(true);
  });

  it('最低要求（2.25）では使えない——保存だけを止める', () => {
    expect(supportsStagedStash(v(2, 25))).toBe(false);
    expect(supportsStagedStash(v(2, 34))).toBe(false);
    expect(supportsStagedStash(v(1, 99))).toBe(false);
  });

  it('バージョンが分からなければ使えない扱い', () => {
    expect(supportsStagedStash(null)).toBe(false);
  });
});
