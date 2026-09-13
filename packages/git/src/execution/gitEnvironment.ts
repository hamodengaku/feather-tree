/**
 * すべての git 実行に共通して付与するオプションと環境変数。
 * 個々のコマンド実装がこれを組み立て直すことは禁止（docs/02-git-command-map.md 共通オプション）。
 */

/**
 * 読み取り系の前置オプション。
 *
 * - `--no-optional-locks`: status がインデックスの stat キャッシュ更新ロックを取らない。
 *   ビルド中・エンジン起動中でも他の git と競合しない。巨大リポで最重要。
 * - `-c core.quotepath=false`: 日本語ファイル名が 8 進エスケープされるのを防ぐ。
 * - `--no-pager`: pager 起動でプロセスが返らなくなるのを防ぐ。
 */
export const READ_PREFIX: readonly string[] = ['--no-pager', '--no-optional-locks', '-c', 'core.quotepath=false'];

/** 書き込み系の前置オプション。インデックスを更新するのでロック抑止は付けない。 */
export const WRITE_PREFIX: readonly string[] = ['--no-pager', '-c', 'core.quotepath=false'];

/** diff 系に追加するオプション。外部 difftool の起動を防ぐ。 */
export const DIFF_EXTRA: readonly string[] = ['--no-color', '--no-ext-diff'];

/** git の出力で使う区切り文字。ファイル名・ブランチ名・コミット件名に出現しない。 */
export const UNIT_SEPARATOR = 0x1f;
export const RECORD_SEPARATOR = 0x00;

/**
 * git に渡す環境変数。
 *
 * `GIT_TERMINAL_PROMPT=0` で認証待ちの無限ハングを防ぐ。
 * `GIT_ASKPASS` / `SSH_ASKPASS` は触らない（OS の資格情報機構に委譲する）。
 *
 * extra はコマンドごとに足す環境変数（クローンの `GIT_LFS_SKIP_SMUDGE` 等）。
 * **固定値より前に合成する**ので、extra で `GIT_TERMINAL_PROMPT` を上書きすることはできない。
 */
export function buildGitEnv(
  base: NodeJS.ProcessEnv,
  extra?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...extra,
    GIT_TERMINAL_PROMPT: '0',
    // 進捗表示を必ず有効にする（stderr へ出る）
    GIT_FLUSH: '1',
  };
}
