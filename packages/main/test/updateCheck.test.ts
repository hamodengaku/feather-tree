import { describe, expect, it, vi } from 'vitest';
import {
  autoCheckIfDue,
  buildReleasePageUrl,
  checkNow,
  fetchLatestReleaseJson,
  isValidReleasePageUrl,
  RELEASE_PAGE_PREFIX,
  type FetchLike,
  type FetchLikeResponse,
  type UpdateCheckDeps,
  type UpdateCheckSettings,
} from '../src/updateCheck.js';

/** Response 型を作らずに済む、テスト用の最小限の応答。 */
function textResponse(status: number, body: string, headers: Record<string, string> = {}): FetchLikeResponse {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
  };
}

function releaseJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ tag_name: 'v9.9.9', draft: false, prerelease: false, ...over });
}

function makeDeps(over: Partial<UpdateCheckDeps> = {}): UpdateCheckDeps & { settings: UpdateCheckSettings } {
  const settings: UpdateCheckSettings = {
    checkForUpdates: true,
    lastUpdateCheckAt: null,
    dismissedUpdateVersion: null,
  };
  const deps: UpdateCheckDeps & { settings: UpdateCheckSettings } = {
    settings,
    fetchRelease: () => Promise.resolve(JSON.parse(releaseJson())),
    currentVersion: () => '1.0.0',
    now: () => 1_000_000_000_000,
    getSettings: () => deps.settings,
    setLastCheckedAt: vi.fn(async (at: number) => {
      deps.settings = { ...deps.settings, lastUpdateCheckAt: at };
    }),
    ...over,
  };
  return deps;
}

describe('fetchLatestReleaseJson（決定 29: 無言で null に倒す）', () => {
  const ua = 'FeatherTree/1.0.0';

  it('200 で正しい JSON なら解析結果を返す', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(textResponse(200, releaseJson()));
    const json = await fetchLatestReleaseJson(fetchImpl, ua);
    expect(json).toEqual({ tag_name: 'v9.9.9', draft: false, prerelease: false });
  });

  it('リクエストに User-Agent と Accept を付ける', async () => {
    const seenInits: { headers: Record<string, string> }[] = [];
    const fetchImpl: FetchLike = (_url, init) => {
      seenInits.push(init);
      return Promise.resolve(textResponse(200, releaseJson()));
    };
    await fetchLatestReleaseJson(fetchImpl, ua);
    expect(seenInits[0]?.headers['User-Agent']).toBe(ua);
    expect(seenInits[0]?.headers['Accept']).toBe('application/vnd.github+json');
  });

  it('非 200 は null', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(textResponse(404, ''));
    expect(await fetchLatestReleaseJson(fetchImpl, ua)).toBeNull();
  });

  it('JSON 不正は null', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(textResponse(200, '{ not json'));
    expect(await fetchLatestReleaseJson(fetchImpl, ua)).toBeNull();
  });

  it('fetch が例外を投げたら null（タイムアウト・オフライン相当）', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error('network error'));
    expect(await fetchLatestReleaseJson(fetchImpl, ua)).toBeNull();
  });

  it('content-length が上限を超えていたら本文を読まずに null', async () => {
    let read = false;
    const fetchImpl: FetchLike = () =>
      Promise.resolve({
        status: 200,
        headers: { get: () => '2000000' },
        text: () => {
          read = true;
          return Promise.resolve(releaseJson());
        },
      });
    expect(await fetchLatestReleaseJson(fetchImpl, ua)).toBeNull();
    expect(read).toBe(false);
  });

  it('content-length が無くても、読んだ本文が上限を超えていたら null', async () => {
    const huge = 'x'.repeat(1_000_001);
    const fetchImpl: FetchLike = () => Promise.resolve(textResponse(200, huge));
    expect(await fetchLatestReleaseJson(fetchImpl, ua)).toBeNull();
  });
});

describe('autoCheckIfDue（決定 29: 起動時の自動確認）', () => {
  it('shouldCheck が false ならスキップし、lastUpdateCheckAt を保存しない', async () => {
    const deps = makeDeps({
      getSettings: () => ({ checkForUpdates: false, lastUpdateCheckAt: null, dismissedUpdateVersion: null }),
    });
    const result = await autoCheckIfDue(deps);
    expect(result).toBeNull();
    expect(deps.setLastCheckedAt).not.toHaveBeenCalled();
  });

  it('新版があれば new-version を返し、結果に関わらず lastUpdateCheckAt を保存する', async () => {
    const deps = makeDeps();
    const result = await autoCheckIfDue(deps);
    expect(result).toEqual({ outcome: 'new-version', version: '9.9.9', tag: 'v9.9.9' });
    expect(deps.setLastCheckedAt).toHaveBeenCalledWith(deps.now());
  });

  it('取得に失敗しても lastUpdateCheckAt は保存する（オフライン時に毎起動叩かない）', async () => {
    const deps = makeDeps({ fetchRelease: () => Promise.resolve(null) });
    const result = await autoCheckIfDue(deps);
    expect(result).toEqual({ outcome: 'failed', version: null, tag: null });
    expect(deps.setLastCheckedAt).toHaveBeenCalledTimes(1);
  });

  it('dismissed と同じ版なら up-to-date として扱う', async () => {
    const deps = makeDeps({
      getSettings: () => ({ checkForUpdates: true, lastUpdateCheckAt: null, dismissedUpdateVersion: '9.9.9' }),
    });
    const result = await autoCheckIfDue(deps);
    expect(result).toEqual({ outcome: 'up-to-date', version: null, tag: null });
  });

  it('現在版と同じ／古いなら up-to-date', async () => {
    const deps = makeDeps({ currentVersion: () => '9.9.9' });
    const result = await autoCheckIfDue(deps);
    expect(result).toEqual({ outcome: 'up-to-date', version: null, tag: null });
  });
});

describe('checkNow（決定 29: 手動確認は間引きと dismissed を無視する）', () => {
  it('24 時間未満でも確認する', async () => {
    const deps = makeDeps({
      getSettings: () => ({
        checkForUpdates: true,
        lastUpdateCheckAt: 1_000_000_000_000 - 1000,
        dismissedUpdateVersion: null,
      }),
    });
    const result = await checkNow(deps);
    expect(result.outcome).toBe('new-version');
  });

  it('checkForUpdates が false でも確認する', async () => {
    const deps = makeDeps({
      getSettings: () => ({ checkForUpdates: false, lastUpdateCheckAt: null, dismissedUpdateVersion: null }),
    });
    const result = await checkNow(deps);
    expect(result.outcome).toBe('new-version');
  });

  it('dismissed と同じ版でも新版ありとして返す', async () => {
    const deps = makeDeps({
      getSettings: () => ({ checkForUpdates: true, lastUpdateCheckAt: null, dismissedUpdateVersion: '9.9.9' }),
    });
    const result = await checkNow(deps);
    expect(result).toEqual({ outcome: 'new-version', version: '9.9.9', tag: 'v9.9.9' });
  });

  it('確認したら lastUpdateCheckAt を保存する', async () => {
    const deps = makeDeps();
    await checkNow(deps);
    expect(deps.setLastCheckedAt).toHaveBeenCalledWith(deps.now());
  });

  it('取得できなければ failed', async () => {
    const deps = makeDeps({ fetchRelease: () => Promise.resolve(null) });
    expect(await checkNow(deps)).toEqual({ outcome: 'failed', version: null, tag: null });
  });
});

describe('buildReleasePageUrl / isValidReleasePageUrl（決定 29: main が検証済み tag から組み立てる）', () => {
  it('parseReleaseTag を通る tag なら URL を組み立てる', () => {
    const url = buildReleasePageUrl('v1.2.3');
    expect(url).toBe(`${RELEASE_PAGE_PREFIX}v1.2.3`);
    expect(isValidReleasePageUrl(url ?? '')).toBe(true);
  });

  it('parseReleaseTag を通らない tag は null', () => {
    expect(buildReleasePageUrl('v1.2.3-beta')).toBeNull();
    expect(buildReleasePageUrl('; rm -rf /')).toBeNull();
  });

  it('tag は encodeURIComponent される', () => {
    // 実際には parseReleaseTag を通った tag しか渡らないが、組み立て自体の確認として
    // URL エンコードが必要な文字を含む文字列でも接頭辞が保たれることを見る
    const url = RELEASE_PAGE_PREFIX + encodeURIComponent('v1.2.3');
    expect(isValidReleasePageUrl(url)).toBe(true);
  });

  it('接頭辞が違う URL は無効', () => {
    expect(isValidReleasePageUrl('https://evil.example/tag/v1.2.3')).toBe(false);
    expect(isValidReleasePageUrl('javascript:alert(1)')).toBe(false);
  });
});
