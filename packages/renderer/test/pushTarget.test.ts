import { describe, expect, it } from 'vitest';
import { commitPushTarget } from '../src/lib/pushTarget.js';
import { branch } from './fakeBridge.js';

describe('コミット&プッシュの行き先', () => {
  it('上流が <remote>/<同名> ならそこへ上流設定なしで送る（#24）', () => {
    const branches = [branch('main', { upstream: 'origin/main' })];
    expect(commitPushTarget('main', branches, ['origin'])).toEqual({
      remote: 'origin',
      branch: 'main',
      setUpstream: false,
    });
  });

  it("リモート名に '/' を含んでも既知のリモート名で突き合わせる", () => {
    const branches = [branch('main', { upstream: 'team/a/main' })];
    expect(commitPushTarget('main', branches, ['origin', 'team/a'])?.remote).toBe('team/a');
  });

  it('上流が無ければ origin へ上流を張って送る（#25）', () => {
    const branches = [branch('feature')];
    expect(commitPushTarget('feature', branches, ['upstream', 'origin'])).toEqual({
      remote: 'origin',
      branch: 'feature',
      setUpstream: true,
    });
  });

  it('上流が無く origin も無ければ、リモートが 1 つのときだけそこへ送る', () => {
    const branches = [branch('feature')];
    expect(commitPushTarget('feature', branches, ['gh'])?.remote).toBe('gh');
    expect(commitPushTarget('feature', branches, ['gh', 'gl'])).toBeNull();
  });

  it('上流の枝名が違う・detached は決めない（ダイアログに任せる）', () => {
    const branches = [branch('main', { upstream: 'origin/master' })];
    expect(commitPushTarget('main', branches, ['origin'])).toBeNull();
    expect(commitPushTarget(null, branches, ['origin'])).toBeNull();
  });
});
