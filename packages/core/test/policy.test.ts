import { describe, expect, it } from 'vitest';
import {
  DESTRUCTIVE_ACTIONS,
  describeAction,
  mapGitOutput,
  mapGitStderr,
  requiresConfirmation,
  validateIdentityValue,
} from '../src/index.js';

describe('破壊的操作のポリシー (決定 16)', () => {
  it('不可逆な操作と、履歴が動く操作が確認対象', () => {
    expect(requiresConfirmation('discard-changes')).toBe(true);
    expect(requiresConfirmation('delete-untracked')).toBe(true);
    expect(requiresConfirmation('force-push')).toBe(true);
    expect(requiresConfirmation('stash-drop')).toBe(true);
    // マージは reset で戻せるが履歴が動くので確認する（決定 16 改定）
    expect(requiresConfirmation('merge-branch')).toBe(true);
  });

  /*
   * 2026-09-19（決定 16 の追記）: 破棄はインデックスを巻き込まなくなったので、
   * 確認は 1 種類だけになった。文言でも「ステージ済みは残る」ことを約束する。
   */
  it('破棄の確認は 1 種類だけ（#8 の廃止）', () => {
    expect(requiresConfirmation('discard-staged-and-worktree')).toBe(false);
    expect(DESTRUCTIVE_ACTIONS.filter((a) => a.startsWith('discard'))).toEqual(['discard-changes']);
  });

  it('破棄の文言は、作業ツリーが失われることとステージ済みが残ることの両方を述べる', () => {
    const spec = describeAction('discard-changes');
    expect(spec.message).toContain('作業ツリー');
    expect(spec.message).toContain('ステージ済み');
    expect(spec.message).toContain('残り');
    expect(spec.recoverable).toBe(false);
  });

  it('日常操作は確認しない（軽量な操作感のため）', () => {
    for (const action of ['stage', 'unstage', 'commit', 'switch-branch', 'fetch', 'pull', 'push', 'merge']) {
      expect(requiresConfirmation(action)).toBe(false);
    }
  });

  it('すべての確認対象に文言が定義されている', () => {
    for (const action of DESTRUCTIVE_ACTIONS) {
      const spec = describeAction(action);
      expect(spec.title.length).toBeGreaterThan(0);
      expect(spec.message.length).toBeGreaterThan(0);
      expect(spec.confirmLabel.length).toBeGreaterThan(0);
    }
  });
});

describe('エラーメッセージのマッピング', () => {
  const cases: readonly [string, string][] = [
    ['fatal: could not read Username for https://github.com', '認証に失敗しました'],
    ['Permission denied (publickey).', '認証に失敗しました'],
    ['! [rejected] main -> main (non-fast-forward)', 'リモートに新しいコミットがあります'],
    // 切替でも stash の展開でも同じ stderr が出る（決定 31 で文言から「切り替え」を外した）
    ['error: Your local changes to the following files would be overwritten by checkout:', '未コミットの変更が上書きされるため'],
    ['error: Your local changes to the following files would be overwritten by merge:', '未コミットの変更が上書きされるため'],
    // stash（決定 31 / 対応表 #27〜#31）
    ['error: t.txt: patch does not apply\nCannot remove worktree changes', 'stash は作成済みです'],
    ['No staged changes', 'ステージした変更がありません'],
    ['You do not have the initial commit yet', 'まだコミットが 1 つもないため'],
    ["error: 'abc1234' is not a stash reference", 'その stash が見つかりません'],
    ['error: stash@{3} is not a valid reference', 'その stash が見つかりません'],
    ["fatal: log for 'stash' only has 1 entries", 'その stash が見つかりません'],
    ['fatal: Unable to create .git/index.lock: File exists.', '他の git プロセスが実行中です'],
    ['CONFLICT (content): Merge conflict in a.txt', 'コンフリクトが発生しました'],
    ['error: external filter git-lfs smudge filter lfs failed', 'Git LFS の処理に失敗しました'],
    ["fatal: a branch named 'feature' already exists", '同名のブランチが既に存在します'],
    ["fatal: 'origin/does-not-exist' is not a valid branch name", 'ブランチ元またはブランチ名が正しくありません'],
    ["fatal: destination path 'repo' already exists and is not an empty directory.", '保存先に同名のフォルダがあり'],
    ['remote: Repository not found.\nfatal: repository \'https://github.com/o/r.git/\' not found', 'リポジトリが見つかりません'],
    ["fatal: 'nowhere' does not appear to be a git repository", 'リポジトリが見つかりません'],
    ["fatal: unable to access 'https://nohost/r.git/': Could not resolve host: nohost", 'リポジトリが見つかりません'],
  ];

  it.each(cases)('%s を日本語へ写す', (stderr, expected) => {
    const mapped = mapGitStderr(stderr, 1);
    expect(mapped.message).toContain(expected);
    // 原文は必ず残す（訳して情報を失わせない）
    expect(mapped.detail).toBe(stderr.trim());
    expect(mapped.exitCode).toBe(1);
  });

  it('未知の stderr は汎用メッセージ + 原文', () => {
    const mapped = mapGitStderr('fatal: something totally unexpected', 128);
    expect(mapped.kind).toBe('git-failed');
    expect(mapped.message).toBe('git の実行に失敗しました。');
    expect(mapped.detail).toBe('fatal: something totally unexpected');
  });

  it('リポジトリでない場合は専用の kind になる', () => {
    const mapped = mapGitStderr('fatal: not a git repository (or any of the parent directories): .git', 128);
    expect(mapped.kind).toBe('not-a-repository');
  });

  /*
   * merge / pull の競合は stdout にしか出ない（stderr は空、pull は fetch の進捗だけ）。
   * 実測は docs/02-git-command-map.md「エラーメッセージのマッピング」。
   */
  it('stderr が空でも stdout の CONFLICT を拾う（マージの競合）', () => {
    const stdout =
      'Auto-merging f.txt\nCONFLICT (content): Merge conflict in f.txt\n' +
      'Automatic merge failed; fix conflicts and then commit the result.\n';

    const mapped = mapGitOutput('', stdout, 1);

    expect(mapped.message).toContain('コンフリクトが発生しました');
    expect(mapped.detail).toBe(stdout.trim());
  });

  it('stderr が進捗だけなら、当たった stdout の原文を detail にする（プルの競合）', () => {
    const stderr = 'remote: Counting objects: 100% (5/5), done.\nFrom D:/repo\n   d303927..2b286e8  main -> origin/main';
    const stdout = 'Auto-merging f.txt\nCONFLICT (content): Merge conflict in f.txt';

    const mapped = mapGitOutput(stderr, stdout, 1);

    expect(mapped.message).toContain('コンフリクトが発生しました');
    // fetch の進捗を見せても仕方がないので、競合を言っている側だけを残す
    expect(mapped.detail).toBe(stdout.trim());
  });

  it('stderr が当たるなら stdout は見ない（未コミットの変更でマージが中止された場合）', () => {
    const stderr =
      'error: Your local changes to the following files would be overwritten by merge:\n\tf.txt\nAborting';
    const mapped = mapGitOutput(stderr, 'Updating d303927..6e9c60d', 1);

    expect(mapped.message).toContain('未コミットの変更が上書きされるため');
    expect(mapped.detail).toBe(stderr.trim());
  });

  it('どちらも当たらなければ、中身のある方の原文を残す', () => {
    expect(mapGitOutput('', 'something on stdout', 1).detail).toBe('something on stdout');
    expect(mapGitOutput('something on stderr', 'noise', 1).detail).toBe('something on stderr');
  });
});

describe('コミット情報の値の検証 (対応表 #42〜#44)', () => {
  const ok = (raw: string): string | null => {
    const r = validateIdentityValue(raw);
    return r.ok ? r.value : null;
  };

  it('前後の空白を落として通す', () => {
    expect(ok('  山田 太郎  ')).toBe('山田 太郎');
  });

  it('日本語・記号入りのメールアドレスも通す（git 自身が形式を要求しない）', () => {
    expect(ok('taro+ft@example.invalid')).toBe('taro+ft@example.invalid');
    expect(ok('名前 (会社)')).toBe('名前 (会社)');
  });

  it('空・空白だけは拒否（--unset はしないので、空は保存しない）', () => {
    expect(validateIdentityValue('')).toEqual({ ok: false, reason: 'empty' });
    expect(validateIdentityValue('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('先頭が - は拒否（他の git 版でオプションと解釈される余地を残さない）', () => {
    expect(validateIdentityValue('-weird')).toEqual({ ok: false, reason: 'leading-dash' });
  });

  it('制御文字は拒否（.git/config の行構造を壊す）', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b']) {
      expect(validateIdentityValue(bad).ok).toBe(false);
    }
  });

  it('255 文字までは通し、超えたら拒否', () => {
    expect(ok('x'.repeat(255))).toHaveLength(255);
    expect(validateIdentityValue('x'.repeat(256))).toEqual({ ok: false, reason: 'too-long' });
  });
});
