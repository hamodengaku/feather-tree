import { describe, expect, it } from 'vitest';
import {
  MAX_HINTS,
  cancelledHint,
  cloneHints,
  gitNotFoundHint,
  lfsMissingHint,
  sshEndpoint,
  type CloneHintContext,
} from '../src/index.js';

/*
 * クローン失敗時のヒント（docs/02-git-command-map.md「クローン失敗時のヒント」）。
 * stderr の例は、git 2.40 / OpenSSH / git-lfs が実際に出す文面に合わせてある。
 */

const ctx: CloneHintContext = { url: 'git@github.com:owner/game.git', target: 'D:\\work\\game', mode: 'normal' };

describe('sshEndpoint', () => {
  it.each([
    ['git@github.com:owner/repo.git', { user: 'git', host: 'github.com', port: null, path: 'owner/repo.git' }],
    [
      'ssh://git@gitlab.example.jp:2222/team/game.git',
      { user: 'git', host: 'gitlab.example.jp', port: 2222, path: 'team/game.git' },
    ],
    ['ssh://gitlab.example.jp/team/game.git', { user: null, host: 'gitlab.example.jp', port: null, path: 'team/game.git' }],
  ])('%s', (url, expected) => {
    expect(sshEndpoint(url)).toEqual(expected);
  });

  it.each(['https://github.com/owner/repo.git', 'file:///D:/work/bare.git', 'D:\\work\\bare', ''])(
    'ssh でなければ null: %s',
    (url) => {
      expect(sshEndpoint(url)).toBeNull();
    },
  );
});

describe('cloneHints', () => {
  it.each([
    ['destination-exists', "fatal: destination path 'game' already exists and is not an empty directory."],
    ['repository-not-found', "fatal: 'D:/work/nowhere' does not appear to be a git repository\nfatal: Could not read from remote repository."],
    ['repository-not-found', 'remote: Repository not found.\nfatal: repository \'https://github.com/owner/missing.git/\' not found'],
    ['ssh-host-key', 'Host key verification failed.\r\nfatal: Could not read from remote repository.'],
    ['ssh-publickey', 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'],
    ['ssh-port', 'ssh: connect to host gitlab.example.jp port 22: Connection timed out\nfatal: Could not read from remote repository.'],
    ['ssh-resolve', 'ssh: Could not resolve hostname gitlab.example.jp: No such host is known.'],
    ['ssh-legacy', 'Unable to negotiate with 10.0.0.5 port 22: no matching host key type found. Their offer: ssh-rsa'],
    ['ssh-closed', 'kex_exchange_identification: read: Connection reset by peer'],
    ['ssh-permissions', 'Bad owner or permissions on C:\\Users\\me/.ssh/config'],
    [
      'https-certificate',
      "fatal: unable to access 'https://git.example.jp/a.git/': SSL certificate problem: self signed certificate in certificate chain",
    ],
    ['https-auth', "fatal: could not read Username for 'https://github.com': terminal prompts disabled"],
    ['https-proxy', "fatal: unable to access 'https://github.com/a.git/': Received HTTP code 407 from proxy after CONNECT"],
    ['network', 'error: RPC failed; curl 56 Recv failure: Connection was reset\nfatal: early EOF\nfatal: index-pack failed'],
    ['path-too-long', 'error: unable to create file Assets/a/b/c.asset: Filename too long\nwarning: Clone succeeded, but checkout failed.'],
    ['invalid-path', "error: invalid path 'Assets/aux.cs'"],
    ['lfs-quota', 'batch response: This repository is over its data quota.'],
    ['lfs-failed', "error: external filter 'git-lfs filter-process' failed\nfatal: Assets/a.png: smudge filter lfs failed"],
    ['disk', "fatal: could not create work tree dir 'D:/full/repo': No space left on device"],
  ])('%s', (id, stderr) => {
    expect(cloneHints(stderr, ctx)[0]?.id).toBe(id);
  });

  it('SSH の鍵エラーは「書き込めない」の Permission denied と取り違えない', () => {
    const ids = cloneHints('git@github.com: Permission denied (publickey).', ctx).map((h) => h.id);
    expect(ids).toEqual(['ssh-publickey']);
  });

  it('当てはまるものを定めた順に最大 3 件まで出す', () => {
    const stderr = [
      'fatal: early EOF',
      'error: unable to create file x: Filename too long',
      'batch response: over its data quota',
      'No space left on device',
    ].join('\n');
    const ids = cloneHints(stderr, ctx).map((h) => h.id);
    expect(ids).toHaveLength(MAX_HINTS);
    expect(ids).toEqual(['network', 'path-too-long', 'lfs-quota']);
  });

  it('どれにも当たらなければ、ログの保存を勧める汎用ヒント 1 件', () => {
    const hints = cloneHints('fatal: something unexpected', ctx);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.id).toBe('generic');
    expect(hints[0]?.body).toContain('ログをコピー');
  });

  it('初回接続の確認コマンドは URL のユーザー・ホスト・ポートで組み立てる', () => {
    const stderr = 'Host key verification failed.';
    expect(cloneHints(stderr, ctx)[0]?.commands).toEqual(['ssh -T git@github.com']);
    expect(
      cloneHints(stderr, { ...ctx, url: 'ssh://git@gitlab.example.jp:2222/team/game.git' })[0]?.commands,
    ).toEqual(['ssh -T -p 2222 git@gitlab.example.jp']);
  });

  it('ポート違いのヒントは、今の URL を ssh:// 形式に書き換えた例を出す', () => {
    const hints = cloneHints('ssh: connect to host github.com port 22: Connection refused', ctx);
    expect(hints[0]?.commands).toEqual(['ssh://git@github.com:<ポート番号>/owner/game.git']);
  });

  it('通信切断では、大規模モード以外なら大規模モードを勧める', () => {
    expect(cloneHints('fatal: early EOF', ctx)[0]?.body).toContain('大規模');
    expect(cloneHints('fatal: early EOF', { ...ctx, mode: 'large' })[0]?.body).not.toContain('大規模');
  });
});

describe('単独のヒント', () => {
  it('git 未導入・LFS 未導入・中止', () => {
    expect(gitNotFoundHint().body).toContain('Git for Windows');
    expect(lfsMissingHint().commands).toContain('git lfs pull');
    expect(cancelledHint('D:\\work\\game', false).body).toContain('D:\\work\\game');
    expect(cancelledHint('D:\\work\\game', true).body).toContain('タブを開きました');
  });
});
