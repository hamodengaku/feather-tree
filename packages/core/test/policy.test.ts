import { describe, expect, it } from 'vitest';
import {
  DESTRUCTIVE_ACTIONS,
  describeAction,
  mapGitStderr,
  requiresConfirmation,
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
    ['error: Your local changes to the following files would be overwritten by checkout:', '未コミットの変更があるため'],
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
});
