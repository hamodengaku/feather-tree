import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  evaluateLatestRelease,
  isNewer,
  parseReleaseTag,
  shouldCheck,
  UPDATE_CHECK_INTERVAL_MS,
} from '../src/index.js';

describe('parseReleaseTag（決定 29）', () => {
  it('v 接頭辞ありなしの major.minor.patch を受理する', () => {
    expect(parseReleaseTag('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseReleaseTag('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseReleaseTag('v0.0.1')).toEqual({ major: 0, minor: 0, patch: 1 });
  });

  it('プレリリース接尾辞は null', () => {
    expect(parseReleaseTag('v1.2.3-beta.1')).toBeNull();
    expect(parseReleaseTag('v1.2.3-rc1')).toBeNull();
  });

  it('異常に長い文字列は null', () => {
    const huge = 'v' + '1'.repeat(40) + '.0.0';
    expect(parseReleaseTag(huge)).toBeNull();
  });

  it('文字列以外・空・不正な形は null', () => {
    expect(parseReleaseTag(null)).toBeNull();
    expect(parseReleaseTag(undefined)).toBeNull();
    expect(parseReleaseTag(123)).toBeNull();
    expect(parseReleaseTag('')).toBeNull();
    expect(parseReleaseTag('v1.2')).toBeNull();
    expect(parseReleaseTag('v1.2.3.4')).toBeNull();
    expect(parseReleaseTag('release-1.2.3')).toBeNull();
  });
});

describe('compareVersions / isNewer', () => {
  it('major → minor → patch の順で比べる', () => {
    expect(compareVersions({ major: 1, minor: 0, patch: 0 }, { major: 2, minor: 0, patch: 0 })).toBeLessThan(0);
    expect(compareVersions({ major: 1, minor: 5, patch: 0 }, { major: 1, minor: 2, patch: 0 })).toBeGreaterThan(0);
    expect(compareVersions({ major: 1, minor: 2, patch: 3 }, { major: 1, minor: 2, patch: 3 })).toBe(0);
  });

  it('isNewer は latest が current より新しいときだけ true', () => {
    expect(isNewer({ major: 1, minor: 0, patch: 1 }, { major: 1, minor: 0, patch: 0 })).toBe(true);
    expect(isNewer({ major: 1, minor: 0, patch: 0 }, { major: 1, minor: 0, patch: 0 })).toBe(false);
    expect(isNewer({ major: 0, minor: 9, patch: 9 }, { major: 1, minor: 0, patch: 0 })).toBe(false);
  });
});

describe('shouldCheck（決定 29: 24 時間に 1 回）', () => {
  const now = 1_000_000_000_000;

  it('無効なら常に false', () => {
    expect(shouldCheck(now, null, false)).toBe(false);
    expect(shouldCheck(now, now - UPDATE_CHECK_INTERVAL_MS * 2, false)).toBe(false);
  });

  it('未確認（null）なら true', () => {
    expect(shouldCheck(now, null, true)).toBe(true);
  });

  it('24 時間未満なら false、以上なら true', () => {
    expect(shouldCheck(now, now - UPDATE_CHECK_INTERVAL_MS + 1000, true)).toBe(false);
    expect(shouldCheck(now, now - UPDATE_CHECK_INTERVAL_MS, true)).toBe(true);
    expect(shouldCheck(now, now - UPDATE_CHECK_INTERVAL_MS - 1, true)).toBe(true);
  });

  it('時計が戻っていたら（lastCheckedAt が未来）true', () => {
    expect(shouldCheck(now, now + 1000, true)).toBe(true);
  });
});

describe('evaluateLatestRelease（決定 29）', () => {
  const CURRENT = '1.2.0';

  it('新版があれば version と tag を返す', () => {
    const result = evaluateLatestRelease({ tag_name: 'v1.3.0' }, CURRENT, null);
    expect(result).toEqual({ version: '1.3.0', tag: 'v1.3.0' });
  });

  it('現在と同じ版なら null', () => {
    expect(evaluateLatestRelease({ tag_name: 'v1.2.0' }, CURRENT, null)).toBeNull();
  });

  it('現在より古い版なら null', () => {
    expect(evaluateLatestRelease({ tag_name: 'v1.1.0' }, CURRENT, null)).toBeNull();
  });

  it('dismissed と同じ版なら null（通知しない）', () => {
    expect(evaluateLatestRelease({ tag_name: 'v1.3.0' }, CURRENT, '1.3.0')).toBeNull();
  });

  it('dismissed が別の版なら通知する', () => {
    expect(evaluateLatestRelease({ tag_name: 'v1.3.0' }, CURRENT, '1.2.5')).toEqual({
      version: '1.3.0',
      tag: 'v1.3.0',
    });
  });

  it('draft / prerelease は null', () => {
    expect(evaluateLatestRelease({ tag_name: 'v1.3.0', draft: true }, CURRENT, null)).toBeNull();
    expect(evaluateLatestRelease({ tag_name: 'v1.3.0', prerelease: true }, CURRENT, null)).toBeNull();
  });

  it('tag_name が不正な形なら null', () => {
    expect(evaluateLatestRelease({ tag_name: 'v1.3.0-beta' }, CURRENT, null)).toBeNull();
    expect(evaluateLatestRelease({ tag_name: 123 }, CURRENT, null)).toBeNull();
    expect(evaluateLatestRelease({}, CURRENT, null)).toBeNull();
  });

  it('json が object でなければ null', () => {
    expect(evaluateLatestRelease(null, CURRENT, null)).toBeNull();
    expect(evaluateLatestRelease('nope', CURRENT, null)).toBeNull();
    expect(evaluateLatestRelease(42, CURRENT, null)).toBeNull();
  });

  it('現在版（app.getVersion()）が解析できない形なら null（安全側に倒す）', () => {
    expect(evaluateLatestRelease({ tag_name: 'v1.3.0' }, 'not-a-version', null)).toBeNull();
  });
});
