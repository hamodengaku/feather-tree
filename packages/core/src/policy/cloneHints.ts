import type { CloneMode } from '../clone/cloneProgress.js';

/*
 * クローン失敗時のヒント（docs/02-git-command-map.md「クローン失敗時のヒント」）。
 *
 * errorMapping.ts が 1 行の日本語に写すのに対し、こちらは「次に何をすればよいか」まで書く。
 * アプリは設定を書き換えない。必要ならコマンドを示すだけ（利用者が自分で打つ）。
 */

export interface CloneHint {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** 利用者がターミナルで打つコマンド。無ければ空。 */
  readonly commands: readonly string[];
}

export interface CloneHintContext {
  readonly url: string;
  /** クローン先のフォルダ（絶対パス）。 */
  readonly target: string;
  readonly mode: CloneMode;
}

/** 1 回の失敗で出すヒントの上限。 */
export const MAX_HINTS = 3;

export interface SshEndpoint {
  readonly user: string | null;
  readonly host: string;
  readonly port: number | null;
  /** ホストより後ろ（`owner/repo.git`）。 */
  readonly path: string;
}

/** ssh の URL（`user@host:path` / `ssh://user@host:port/path`）からホストとポートを取る。ssh でなければ null。 */
export function sshEndpoint(url: string): SshEndpoint | null {
  const text = url.trim();
  const full = /^ssh:\/\/(?:([^@/]+)@)?([^:/]+)(?::(\d+))?\/(.*)$/i.exec(text);
  if (full !== null) {
    const [, user, host = '', port, path = ''] = full;
    return { user: user ?? null, host, port: port === undefined ? null : Number(port), path };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[a-z]:[\\/]/i.test(text)) return null;
  const scp = /^(?:([^@/:]+)@)?([^/:]+):(.*)$/.exec(text);
  if (scp === null) return null;
  const [, user, host = '', path = ''] = scp;
  return { user: user ?? null, host, port: null, path };
}

function sshTestCommand(url: string): string | null {
  const endpoint = sshEndpoint(url);
  if (endpoint === null) return null;
  const who = (endpoint.user === null ? '' : endpoint.user + '@') + endpoint.host;
  return 'ssh -T ' + (endpoint.port === null ? '' : '-p ' + String(endpoint.port) + ' ') + who;
}

interface Rule {
  readonly id: string;
  readonly test: RegExp;
  readonly hint: (ctx: CloneHintContext) => Omit<CloneHint, 'id'>;
}

const RULES: readonly Rule[] = [
  {
    id: 'destination-exists',
    test: /destination path .* already exists and is not an empty directory/i,
    hint: () => ({
      title: '保存先に同じ名前のフォルダがあり、空ではありません',
      body: '「戻る」でフォルダ名を変えるか、別の保存先を選んでください。前回クローン時のゴミなら、フォルダを削除してからやり直してください。',
      commands: [],
    }),
  },
  {
    id: 'ssh-host-key',
    test: /Host key verification failed/i,
    hint: (ctx) => ({
      title: 'SSH の初回接続の確認が済んでいません',
      body:
        'はじめて接続するサーバーの場合「このサーバーを信頼しますか」と聞かれますが、このアプリからは答えられません。' +
        'ターミナルから以下を実行し、疎通を行ってから再実行してください。' +
        'ポートが 22 番以外のサーバー（独自の GitLab など）の場合は -p にポート番号をつけるか、sshコンフィグを設定してください。',
      commands: [sshTestCommand(ctx.url) ?? 'ssh -T git@<ホスト名>'],
    }),
  },
  {
    id: 'ssh-publickey',
    test: /Permission denied \(publickey/i,
    hint: (ctx) => ({
      title: 'SSH の鍵が登録されていないか、見つかりません',
      body:
        '公開鍵（~/.ssh/id_ed25519.pub など）を GitHub / GitLab のアカウント設定に登録してください。' +
        '登録済みで失敗する場合は、Windows の ssh-agent に入れた鍵を Git の ssh が参照していない可能性があります。' +
        '1 行目で接続を確かめられます。 2 行目のコマンドで Windows の ssh を使うように切り替えます。',
      commands: [
        sshTestCommand(ctx.url) ?? 'ssh -T git@<ホスト名>',
        'git config --global core.sshCommand C:/Windows/System32/OpenSSH/ssh.exe',
      ],
    }),
  },
  {
    id: 'ssh-port',
    test: /connect to host .* port \d+: (Connection timed out|Connection refused|Network is unreachable)/i,
    hint: (ctx) => {
      const endpoint = sshEndpoint(ctx.url);
      const example =
        endpoint === null
          ? 'ssh://git@<ホスト名>:<ポート番号>/owner/repo.git'
          : 'ssh://' + (endpoint.user === null ? '' : endpoint.user + '@') + endpoint.host + ':<ポート番号>/' + endpoint.path;
      return {
        title: 'SSH のポートにつながりません',
        body:
          '独自に立てた GitLab などでは、SSH が 22 番以外のポートのことがあります。' +
          'その場合 git@host:owner/repo.git の形ではポートを指定できないので、URL を次の形に書き換えるかsshコンフィグを設定してください。',
        commands: [example],
      };
    },
  },
  {
    id: 'ssh-resolve',
    test: /Could not resolve hostname/i,
    hint: () => ({
      title: 'サーバー名が見つかりません',
      body: 'URL のホスト名の綴りを確認してください。',
      commands: [],
    }),
  },
  {
    id: 'ssh-legacy',
    test: /no matching (host key type|key exchange method|cipher)/i,
    hint: () => ({
      title: 'サーバーの SSH の方式が古く、接続を拒否されました',
      body: 'サーバー管理者に SSH の更新を依頼するか、https の URL でクローンしてください。',
      commands: [],
    }),
  },
  {
    id: 'ssh-closed',
    test: /kex_exchange_identification|Connection closed by remote host|Connection reset by peer/i,
    hint: () => ({
      title: 'サーバーが接続を切りました',
      body: 'ポート番号が SSH のものでないか、サーバーが混み合っている可能性があります。少し待ってから再実行し、続くようなら管理者に確認してください。',
      commands: [],
    }),
  },
  {
    id: 'ssh-permissions',
    test: /Bad owner or permissions on/i,
    hint: () => ({
      title: '.ssh フォルダの権限が正しくありません',
      body: 'エラーに出ているファイル（~/.ssh/config など）が、自分以外のユーザーからも読める設定になっています。自分以外のアクセス権を外してください。',
      commands: [],
    }),
  },
  {
    id: 'https-certificate',
    test: /SSL certificate problem|unable to get local issuer certificate|self[- ]signed certificate/i,
    hint: () => ({
      title: 'サーバーの証明書を確認できません',
      body: '独自に立てたサーバーや、社内のプロキシが証明書を差し替えている可能性があります。',
      commands: ['git config --global http.sslBackend schannel'],
    }),
  },
  {
    id: 'https-auth',
    test: /could not read Username|Authentication failed|could not read Password|HTTP Basic: Access denied/i,
    hint: () => ({
      title: 'https の認証に失敗しました',
      body:
        'このアプリはパスワードの入力画面サポートしていません。Git Credential Manager（Git for Windows に同梱）がサインイン画面を出す必要があります。' +
        'ターミナルで一度 git clone を実行してサインインを済ませるか、アクセストークンの権限を確認してください。',
      commands: ['git config --global credential.helper manager'],
    }),
  },
  {
    id: 'https-proxy',
    test: /Proxy CONNECT aborted|Received HTTP code 407|proxy/i,
    hint: () => ({
      title: 'プロキシを通過できません',
      body: 'ネットワークのプロキシ設定が必要です。アドレスは管理者に確認してください。',
      commands: ['git config --global http.proxy http://<プロキシ>:<ポート>'],
    }),
  },
  {
    id: 'repository-not-found',
    test: /Repository not found|does not appear to be a git repository|The project you were looking for could not be found|HTTP code 404|returned error: 404/i,
    hint: () => ({
      title: 'リポジトリが見つかりません',
      body: 'URL の綴りを確認してください。非公開のリポジトリの場合、アクセス権がない可能性もあります。ブラウザでそのリポジトリを開けるか確認してください。',
      commands: [],
    }),
  },
  {
    id: 'network',
    test: /RPC failed|early EOF|remote end hung up|curl \d*\s*(18|28|56|92)|HTTP\/2 stream|Operation timed out|transfer closed with outstanding read data|unexpected disconnect|index-pack failed/i,
    hint: (ctx) => ({
      title: '通信が途中で切れました',
      body:
        (ctx.mode === 'large'
          ? ''
          : 'リポジトリが大きいと、途中でタイムアウトしやすくなります。クローンオプション「大規模レポジトリをいい感じにクローンする」でやり直してください。') ,
      commands: ['git config --global http.version HTTP/1.1'],
    }),
  },
  {
    id: 'path-too-long',
    test: /Filename too long|Clone succeeded, but checkout failed/i,
    hint: () => ({
      title: '履歴は取れましたが、ファイルを書き出せませんでした',
      body:
        'Windows のパスの長さの上限（260 文字）を超えるファイルがあると起きます。' +
        '1 行目で長いパスを許可してから、クローンしたフォルダで 2 行目を実行するとファイルが書き出されます。' +
        'それまでタブにはすべてのファイルが削除されたように表示されますが、履歴は無事です。保存先を浅いフォルダ（D:\\work など）にするのも有効です。',
      commands: ['git config --global core.longpaths true', 'git restore --source=HEAD :/'],
    }),
  },
  {
    id: 'invalid-path',
    test: /invalid path/i,
    hint: () => ({
      title: 'Windows で使えないファイル名が含まれています',
      body: 'aux / con / nul のような予約された名前や、末尾が空白・ドットの名前は Windows では作れません。リポジトリ側でファイル名を変えてもらう必要があります。',
      commands: [],
    }),
  },
  {
    id: 'lfs-quota',
    test: /over (its )?(data )?quota|exceeded .*(storage|bandwidth)/i,
    hint: () => ({
      title: 'LFS の容量（または転送量）の上限を超えています',
      body: 'サーバー側の制限です。履歴だけはクローンできています。',
      commands: [],
    }),
  },
  {
    id: 'lfs-failed',
    test: /smudge filter lfs failed|batch response|LFS: |git-lfs.*(failed|error)|external filter .*lfs/i,
    hint: () => ({
      title: 'LFS ファイルの取得に失敗しました',
      body: 'LFS の認証や通信が原因のことが多いです。時間をおいて、クローンしたフォルダで次を実行すると続きから取得できます。',
      commands: ['git lfs pull'],
    }),
  },
  {
    id: 'disk',
    test: /No space left|not enough space|unable to create file|unable to unlink|Permission denied(?! \()|could not create work tree dir|Invalid argument/i,
    hint: () => ({
      title: 'ファイルを書き込めません',
      body:
        'ディスクの空き容量を確認してください。容量が十分なら、ウイルス対策ソフト等がファイルを編集している可能性もあります。' +
        'また保存先が OneDrive などの同期フォルダの中にある可能性もあります。同期されない場所（D:\\work など）を保存先にしてください。',
      commands: [],
    }),
  },
];

const GENERIC: CloneHint = {
  id: 'generic',
  title: '原因を特定できませんでした',
  body: '下の「ログをコピー」でログの詳細を確認してください。',
  commands: [],
};

/**
 * stderr から当てはまるヒントを上から最大 3 件返す。どれにも当たらなければ汎用ヒント 1 件。
 * 複数の stderr（大規模クローンで複数の手が失敗した場合）はつなげて渡す。
 */
export function cloneHints(stderr: string, ctx: CloneHintContext): CloneHint[] {
  const matched = RULES.filter((rule) => rule.test.test(stderr))
    .slice(0, MAX_HINTS)
    .map((rule) => ({ id: rule.id, ...rule.hint(ctx) }));
  return matched.length > 0 ? matched : [GENERIC];
}

export function gitNotFoundHint(): CloneHint {
  return {
    id: 'git-not-found',
    title: 'git が見つかりません',
    body: 'Git for Windows（https://gitforwindows.org/）をインストールしてから、このアプリを再起動してください。',
    commands: [],
  };
}

/** LFS を使うリポジトリなのに git-lfs が無い（失敗ではなく警告）。 */
export function lfsMissingHint(): CloneHint {
  return {
    id: 'lfs-missing',
    title: 'Git LFS が入っていないため、大きなファイルが取得されていません',
    body:
      'このリポジトリは Git LFS を使っていますが、この PC では git lfs が使えません。' +
      'Git LFS（https://git-lfs.com/）をインストールしてから、クローンしたフォルダで次を実行してください。',
    commands: ['git lfs install', 'git lfs pull'],
  };
}

export function cancelledHint(target: string, cloneFinished: boolean): CloneHint {
  return cloneFinished
    ? {
        id: 'cancelled',
        title: '途中で中止しました',
        body:
          'クローン自体は済んでいるのでタブを開きました。残りの手順は、クローンしたフォルダで下のコマンドを実行すると続けられます。' +
          '中止のしかたによっては .git\\shallow.lock が残り、次の fetch が失敗することがあります。その場合はそのファイルを削除してください。',
        commands: [],
      }
    : {
        id: 'cancelled',
        title: '途中で中止しました',
        body: '作りかけのフォルダが残っていることがあります。やり直す前に、次のフォルダを削除してください：' + target,
        commands: [],
      };
}
