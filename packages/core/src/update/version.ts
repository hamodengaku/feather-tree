/**
 * 更新通知（決定 29）が扱う「バージョン」の純関数群。
 *
 * electron も IPC も知らない。GitHub の releases API から来る文字列を安全に
 * 数値化し、比較するだけの層。
 */

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * `v1.2.3` / `1.2.3` を超えて育つ理由が無いので、これより長い入力は素性を疑って弾く。
 * プレリリース接尾辞（`-beta.1` 等）を切り落とさずそのまま拒否するのにも使う
 * （正規表現が末尾までの完全一致なので、接尾辞があれば length チェックの前に落ちるが、
 * 巨大な数字列を無限に食わせて Number 変換を歪ませる入力はここで止める）。
 */
const MAX_TAG_LENGTH = 32;

const RELEASE_TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * リリースタグ（`tag_name`）を解析する。
 *
 * `^v?\d+\.\d+\.\d+$` だけを受理する。プレリリース接尾辞・異常に長い文字列・
 * 数値化できない桁は null にして、呼び出し側が「安全に判断できない」として
 * 何もしない側へ倒せるようにする。
 */
export function parseReleaseTag(tag: unknown): Version | null {
  if (typeof tag !== 'string' || tag.length === 0 || tag.length > MAX_TAG_LENGTH) return null;

  const match = RELEASE_TAG_PATTERN.exec(tag);
  if (match === null) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/** major → minor → patch の順で比べる。a < b なら負、等しければ 0、a > b なら正。 */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** latest が current より新しいか（同一・古いは false）。 */
export function isNewer(latest: Version, current: Version): boolean {
  return compareVersions(latest, current) > 0;
}
