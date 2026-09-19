import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, buildSshCommand, gitSshEnv, sshKeyFor } from '../src/index.js';

/*
 * GIT_SSH_COMMAND の引用規則（決定 13 の追記）。
 *
 * git はこの値を**シェルのコマンド文字列として解釈する**ので、引用を 1 文字でも
 * 間違えると「鍵が違う」ではなく「ssh が起動しない／別のパスを見に行く」という
 * 分かりにくい壊れ方をする。**期待値はベタ書きで固定する**（生成規則を
 * テスト側でも組み立てると、同じ間違いを両側でして緑になる）。
 */
const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const SSH_Q = "'C:/Windows/System32/OpenSSH/ssh.exe'";

describe('GIT_SSH_COMMAND の組み立て', () => {
  it('ssh か鍵のどちらかが無ければ null（何も注入しない＝OS の機構に委譲する）', () => {
    expect(buildSshCommand(SSH, null)).toBeNull();
    expect(buildSshCommand(SSH, '')).toBeNull();
    // ssh が見つかっていなければ、鍵が登録されていても注入しない
    expect(buildSshCommand(null, 'C:\\Users\\me\\.ssh\\id_ed25519')).toBeNull();
  });

  it('ssh も鍵も絶対パスで引用する（bare 名の ssh は渡さない。診断 1-A）', () => {
    expect(buildSshCommand(SSH, 'C:\\Users\\me\\.ssh\\id_ed25519')).toBe(
      SSH_Q + " -i 'C:/Users/me/.ssh/id_ed25519' -o IdentitiesOnly=yes",
    );
  });

  it('バックスラッシュを / に変換する（sh がエスケープとして食うため）', () => {
    expect(buildSshCommand(SSH, 'D:\\keys\\id_ed25519')).toContain("-i 'D:/keys/id_ed25519'");
  });

  it('空白を含むパスはシングルクォートで囲む', () => {
    expect(buildSshCommand(SSH, 'C:\\path with space\\id_ed25519')).toContain(
      "-i 'C:/path with space/id_ed25519'",
    );
  });

  it('値の中のシングルクォートを閉じ直す', () => {
    // 'it''s' ではなく 'it'\''s' の形（POSIX sh で 1 語に戻る唯一の書き方）
    expect(buildSshCommand(SSH, "C:\\it's\\id_ed25519")).toContain("-i 'C:/it'\\''s/id_ed25519'");
  });

  it('ssh 側のパスに空白があっても 1 語に収まる', () => {
    expect(buildSshCommand('C:\\Program Files\\Git\\usr\\bin\\ssh.exe', 'C:\\k\\id')).toBe(
      "'C:/Program Files/Git/usr/bin/ssh.exe' -i 'C:/k/id' -o IdentitiesOnly=yes",
    );
  });

  it('相対パス・bare 名・制御文字は null（注入しない）', () => {
    expect(buildSshCommand(SSH, 'id_ed25519')).toBeNull();
    expect(buildSshCommand(SSH, '.ssh/id_ed25519')).toBeNull();
    expect(buildSshCommand(SSH, 'C:\\a\nb')).toBeNull();
    // ssh 側も同じ規則。bare 名は通さない
    expect(buildSshCommand('ssh', 'C:\\k\\id')).toBeNull();
    expect(buildSshCommand('ssh.exe', 'C:\\k\\id')).toBeNull();
  });
});

describe('リポジトリごとの鍵', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    sshKeyPaths: {
      'D:\\work\\alpha': 'C:\\keys\\alpha_ed25519',
      'D:\\work\\beta': 'C:\\keys\\beta_ed25519',
    },
  };

  it('登録のあるリポジトリはその鍵を返す', () => {
    expect(sshKeyFor(settings, 'D:\\work\\alpha')).toBe('C:\\keys\\alpha_ed25519');
    expect(sshKeyFor(settings, 'D:\\work\\beta')).toBe('C:\\keys\\beta_ed25519');
  });

  it('登録の無いリポジトリは null（他のリポジトリの鍵を巻き添えにしない）', () => {
    expect(sshKeyFor(settings, 'D:\\work\\gamma')).toBeNull();
    expect(sshKeyFor(DEFAULT_SETTINGS, 'D:\\work\\alpha')).toBeNull();
  });

  it('gitSshEnv は鍵が無ければ空を返す（環境変数を足さない）', () => {
    expect(gitSshEnv(SSH, sshKeyFor(settings, 'D:\\work\\gamma'))).toEqual({});
  });

  it('gitSshEnv は鍵があれば GIT_SSH_COMMAND だけを返す', () => {
    expect(gitSshEnv(SSH, sshKeyFor(settings, 'D:\\work\\alpha'))).toEqual({
      GIT_SSH_COMMAND: SSH_Q + " -i 'C:/keys/alpha_ed25519' -o IdentitiesOnly=yes",
    });
  });
});
