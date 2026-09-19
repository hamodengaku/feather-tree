/**
 * 更新通知（決定 29）: 「いつ確認するか」と「応答をどう読むか」の純関数。
 *
 * fetch もタイマーも持たない。main（`packages/main/src/updateCheck.ts`）が
 * これらに実際の設定値・現在時刻・API 応答を渡して使う。
 */

import { isNewer, parseReleaseTag } from './version.js';

/** 自動確認の間引き（決定 29: 最後の確認から 24 時間以上）。 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 自動確認を行うべきか。
 *
 * - 設定でオフ（`checkForUpdates: false`）なら常に false
 * - 未確認（`lastCheckedAt === null`）なら true
 * - 時計が戻っていた（`lastCheckedAt` が `now` より未来）場合も true にする。
 *   遅れて確認するより、1 回余分に確認しても実害が無いため
 * - それ以外は 24 時間以上経過していれば true
 */
export function shouldCheck(now: number, lastCheckedAt: number | null, enabled: boolean): boolean {
  if (!enabled) return false;
  if (lastCheckedAt === null) return true;
  if (lastCheckedAt > now) return true;
  return now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
}

/** 通知すべき新版。version は 'x.y.z'（表示・dismissed の比較用）、tag は API 応答そのまま。 */
export interface LatestRelease {
  readonly version: string;
  readonly tag: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * GitHub の `releases/latest` 応答から「通知すべき新版があるか」を判定する。
 *
 * 見るのは `tag_name` / `draft` / `prerelease` の 3 つだけ。`html_url` や本文（リリースノート）
 * はここでも読まない（決定 29: renderer へ渡さない境界を、読む側にも作っておく）。
 *
 * null になるのは: json の形が不正 / draft・prerelease / tag が解析できない /
 * 現在版が解析できない / 新しくない / dismissed と同じ版。
 */
export function evaluateLatestRelease(
  json: unknown,
  currentVersion: string,
  dismissedVersion: string | null,
): LatestRelease | null {
  if (!isRecord(json)) return null;
  if (json['draft'] === true || json['prerelease'] === true) return null;

  const rawTag = json['tag_name'];
  const latest = parseReleaseTag(rawTag);
  if (latest === null) return null;

  const current = parseReleaseTag(currentVersion);
  if (current === null) return null;

  if (!isNewer(latest, current)) return null;

  const version = `${latest.major}.${latest.minor}.${latest.patch}`;
  if (dismissedVersion === version) return null;

  // latest が null でない時点で rawTag は parseReleaseTag が受理した文字列
  return { version, tag: rawTag as string };
}
