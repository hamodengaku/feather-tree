/**
 * 更新通知（決定 29）: main 側の確認処理。
 *
 * fetch を注入可能にしてあるので、実 HTTP を通さずテストできる。
 * ここでは electron を import しない（`net.fetch` を渡すのは呼び出し側 = handlers/update.ts）。
 * その代わりに ipcMain / shell への配線はしない——それも handlers/update.ts の役目。
 */

import { evaluateLatestRelease, parseReleaseTag, shouldCheck } from '@feathertree/core';

/** GitHub の未認証 API（60 回/時/IP）。決定 29: 送る情報はリクエストそのもの以外に無い。 */
export const GITHUB_RELEASES_LATEST_URL = 'https://api.github.com/repos/hamodengaku/feather-tree/releases/latest';

/** ブラウザで開く URL の接頭辞。tag は必ず parseReleaseTag を通したものだけを後ろへ付ける。 */
export const RELEASE_PAGE_PREFIX = 'https://github.com/hamodengaku/feather-tree/releases/tag/';

/** 応答の待ち時間（決定 29: 5 秒タイムアウト）。 */
const FETCH_TIMEOUT_MS = 5000;

/** 応答サイズの上限。GitHub の releases API の JSON がこれを超えることは想定していない。 */
const MAX_RESPONSE_BYTES = 1_000_000;

/**
 * 起動時の自動確認を本体表示から遅らせる時間（決定 28 の起動は 1ms も遅らせない位置から呼ぶが、
 * 呼んだ直後に叩くとネットワーク処理が起動直後の重い時間帯と重なるので、数秒待つ）。
 */
export const STARTUP_UPDATE_CHECK_DELAY_MS = 3000;

/**
 * `fetch` 互換の最小限の型。本番は Electron の `net.fetch` を渡す。
 * テストでは `Response` を作らずに済むよう、必要な部分だけを持つオブジェクトを渡せる。
 */
export interface FetchLikeResponse {
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal },
) => Promise<FetchLikeResponse>;

/**
 * `releases/latest` を 1 回 GET して JSON を返す。
 *
 * 非 200・応答サイズ超過・JSON パース失敗・タイムアウト・オフラインは**無言で null**
 * （決定 29: エラー表示もログ汚しもしない）。呼び出し元はこれ以上の握り潰しをしなくてよい。
 */
export async function fetchLatestReleaseJson(fetchImpl: FetchLike, userAgent: string): Promise<unknown | null> {
  let response: FetchLikeResponse;
  try {
    response = await fetchImpl(GITHUB_RELEASES_LATEST_URL, {
      method: 'GET',
      headers: { 'User-Agent': userAgent, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    // タイムアウト・DNS 失敗・オフライン等。区別しても打つ手が無いのでまとめて諦める
    return null;
  }

  if (response.status !== 200) return null;

  // ヘッダで分かるならボディを読む前に諦める（決定 29: 1MB 超は読まない）
  const contentLength = response.headers?.get('content-length') ?? null;
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return null;
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.length > MAX_RESPONSE_BYTES) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 確認 1 回の結果。main はこれを UpdateStateDto へ写して renderer に渡す。 */
export type UpdateCheckOutcome = 'new-version' | 'up-to-date' | 'failed';

export interface UpdateCheckResult {
  readonly outcome: UpdateCheckOutcome;
  /** outcome が 'new-version' のときだけ値を持つ。 */
  readonly version: string | null;
  /** 通知に使う検証済みタグ（API 応答の tag_name そのまま）。outcome が 'new-version' のときだけ値を持つ。 */
  readonly tag: string | null;
}

const NOT_NEW: UpdateCheckResult = { outcome: 'up-to-date', version: null, tag: null };
const FAILED: UpdateCheckResult = { outcome: 'failed', version: null, tag: null };

export interface UpdateCheckSettings {
  readonly checkForUpdates: boolean;
  readonly lastUpdateCheckAt: number | null;
  readonly dismissedUpdateVersion: string | null;
}

export interface UpdateCheckDeps {
  readonly fetchRelease: () => Promise<unknown | null>;
  readonly currentVersion: () => string;
  readonly now: () => number;
  readonly getSettings: () => UpdateCheckSettings;
  /** 結果に関わらず試みたら呼ぶ（決定 29: オフライン時に毎起動叩かないため）。 */
  readonly setLastCheckedAt: (at: number) => Promise<void>;
}

async function evaluate(deps: UpdateCheckDeps, dismissedVersion: string | null): Promise<UpdateCheckResult> {
  const json = await deps.fetchRelease();
  if (json === null) return FAILED;

  const found = evaluateLatestRelease(json, deps.currentVersion(), dismissedVersion);
  if (found === null) return NOT_NEW;
  return { outcome: 'new-version', version: found.version, tag: found.tag };
}

/**
 * 自動確認（本体ウィンドウ表示後）。
 *
 * `shouldCheck` が false なら何もせず null を返す（lastUpdateCheckAt も更新しない）。
 * 行ったときは**結果に関わらず** lastUpdateCheckAt を保存する
 * （決定 29: オフライン時に毎起動叩かないため）。
 */
export async function autoCheckIfDue(deps: UpdateCheckDeps): Promise<UpdateCheckResult | null> {
  const settings = deps.getSettings();
  const now = deps.now();
  if (!shouldCheck(now, settings.lastUpdateCheckAt, settings.checkForUpdates)) return null;

  const result = await evaluate(deps, settings.dismissedUpdateVersion);
  await deps.setLastCheckedAt(now);
  return result;
}

/**
 * 手動確認（`update:checkNow`）。
 *
 * 24 時間の間引きも dismissed も無視する。それでも「確認した」事実は残すので、
 * lastUpdateCheckAt は更新する（次の自動確認がすぐには走らなくなる）。
 */
export async function checkNow(deps: UpdateCheckDeps): Promise<UpdateCheckResult> {
  const result = await evaluate(deps, null);
  await deps.setLastCheckedAt(deps.now());
  return result;
}

/**
 * ダウンロードページの URL を組み立てる。tag が `parseReleaseTag` を通らなければ null
 * （決定 29: API 応答をそのまま `shell.openExternal` に渡さない）。
 */
export function buildReleasePageUrl(tag: string): string | null {
  if (parseReleaseTag(tag) === null) return null;
  return RELEASE_PAGE_PREFIX + encodeURIComponent(tag);
}

/** `shell.openExternal` に渡す直前の再検証（決定 29）。 */
export function isValidReleasePageUrl(url: string): boolean {
  return url.startsWith(RELEASE_PAGE_PREFIX);
}
