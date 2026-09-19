import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, buildSshCommand, gitSshEnv } from '../src/index.js';

/*
 * GIT_SSH_COMMAND の引用規則（決定 13 の追記）。
 *
 * git はこの値を**シェルのコマンド文字列として解釈する**ので、引用を 1 文字でも
 * 間違えると「鍵が違う」ではなく「ssh が起動しない／別のパスを見に行く」という
 * 分かりにくい壊れ方をする。**期待値はベタ書きで固定する**（生成規則を
 * テスト側でも組み立てると、同じ間違いを両側でして緑になる）。
 */
describe('GIT_SSH_COMMAND の組み立て', () => {
  it('鍵が無ければ null（何も注入しない＝OS の機構に委譲する）', () => {
    expect(buildSshCommand(null)).toBeNull();
    expect(buildSshCommand('')).toBeNull();
  });

  it('バックスラッシュを / に変換する（sh がエスケープとして食うため）', () => {
    expect(buildSshCommand('C:\\Users\\me\\.ssh\\id_ed25519')).toBe(
      "ssh -i 'C:/Users/me/.ssh/id_ed25519' -o IdentitiesOnly=yes",
    );
  });

  it('空白を含むパスはシングルクォートで囲む', () => {
    expect(buildSshCommand('C:\\path with space\\id_ed25519')).toBe(
      "ssh -i 'C:/path with space/id_ed25519' -o IdentitiesOnly=yes",
    );
  });

  it('値の中のシングルクォートを閉じ直す', () => {
    // 'it''s' ではなく 'it'\''s' の形（POSIX sh で 1 語に戻る唯一の書き方）
    expect(buildSshCommand("C:\\it's\\id_ed25519")).toBe(
      "ssh -i 'C:/it'\\''s/id_ed25519' -o IdentitiesOnly=yes",
    );
  });

  it('/ 区切りで書かれた絶対パスもそのまま通る', () => {
    expect(buildSshCommand('C:/Users/me/.ssh/id_rsa')).toBe(
      "ssh -i 'C:/Users/me/.ssh/id_rsa' -o IdentitiesOnly=yes",
    );
  });

  it('相対パス・bare 名・制御文字は null（注入しない）', () => {
    expect(buildSshCommand('id_ed25519')).toBeNull();
    expect(buildSshCommand('.ssh/id_ed25519')).toBeNull();
    expect(buildSshCommand('C:\\a\nb')).toBeNull();
  });

  it('gitSshEnv は未設定なら空を返す（環境変数を足さない）', () => {
    expect(gitSshEnv(DEFAULT_SETTINGS)).toEqual({});
  });

  it('gitSshEnv は設定済みなら GIT_SSH_COMMAND だけを返す', () => {
    const env = gitSshEnv({ ...DEFAULT_SETTINGS, sshKeyPath: 'C:\\Users\\me\\.ssh\\id_ed25519' });
    expect(env).toEqual({
      GIT_SSH_COMMAND: "ssh -i 'C:/Users/me/.ssh/id_ed25519' -o IdentitiesOnly=yes",
    });
  });
});
