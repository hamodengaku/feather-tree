import { describe, expect, it } from 'vitest';
import { CloneProgressTracker, parseProgressLine, planStages, type CloneStage } from '../src/index.js';

/*
 * クローンの段階表と進捗行の解析（決定 9）。
 * 行の形は git 2.40 / git-lfs 3.3 の stderr（CR で上書きされる 1 行ずつ）に合わせてある。
 */

describe('planStages', () => {
  it('通常・シャローはクローンの 7 段階、大規模は LFS と unshallow を足した 14 段階', () => {
    expect(planStages('normal')).toHaveLength(7);
    expect(planStages('shallow')).toHaveLength(7);
    const large = planStages('large');
    expect(large).toHaveLength(14);
    expect(new Set(large.map((s) => s.id)).size).toBe(14);
    expect(large.map((s) => s.group)).toEqual([
      ...Array<string>(6).fill('clone'),
      'lfs',
      'lfs',
      'config',
      ...Array<string>(5).fill('unshallow'),
    ]);
  });

  it('LFS の展開の段階は、smudge を止めない通常・シャローにだけある', () => {
    expect(planStages('normal').some((s) => s.id === 'clone-filter')).toBe(true);
    expect(planStages('large').some((s) => s.id === 'clone-filter')).toBe(false);
  });
});

describe('parseProgressLine', () => {
  it.each([
    [
      'Receiving objects:  45% (5/11), 1.20 MiB | 2.00 MiB/s',
      { title: 'Receiving objects', percent: 45, current: 5, total: 11, detail: '1.20 MiB | 2.00 MiB/s', done: false },
    ],
    [
      'Receiving objects: 100% (11/11), 2.40 MiB | 2.00 MiB/s, done.',
      { title: 'Receiving objects', percent: 100, current: 11, total: 11, detail: '2.40 MiB | 2.00 MiB/s', done: true },
    ],
    [
      'remote: Enumerating objects: 12, done.',
      { title: 'Enumerating objects', percent: null, current: 12, total: null, detail: null, done: true },
    ],
    [
      'remote: Counting objects:  50% (6/12)',
      { title: 'Counting objects', percent: 50, current: 6, total: 12, detail: null, done: false },
    ],
    [
      'Resolving deltas: 100% (3/3), done.',
      { title: 'Resolving deltas', percent: 100, current: 3, total: 3, detail: null, done: true },
    ],
    [
      'Downloading LFS objects:  50% (1/2), 10 MB | 5.0 MB/s',
      { title: 'Downloading LFS objects', percent: 50, current: 1, total: 2, detail: '10 MB | 5.0 MB/s', done: false },
    ],
  ])('%s', (line, expected) => {
    expect(parseProgressLine(line)).toEqual(expected);
  });

  it.each([
    "Cloning into 'repo'...",
    'remote: Total 12 (delta 0), reused 0 (delta 0), pack-reused 0',
    'From file:///D:/work/bare.git',
    ' * [new branch]      feature    -> origin/feature',
    '',
  ])('進捗ではない行は null: %s', (line) => {
    expect(parseProgressLine(line)).toBeNull();
  });
});

describe('CloneProgressTracker', () => {
  /** 呼ぶたびに 1000ms 進む時計。所要時間を固定するため。 */
  function clock(): () => number {
    let t = 0;
    return () => (t += 1000);
  }
  const byId = (stages: CloneStage[], id: string): CloneStage => {
    const found = stages.find((s) => s.id === id);
    if (found === undefined) throw new Error(id);
    return found;
  };

  it('手を始めると最初の段階が実行中になり、行に合わせて前の段階を閉じながら進む', () => {
    const tracker = new CloneProgressTracker('shallow', clock());

    expect(tracker.feed('remote: Enumerating objects: 12, done.')).toBe('none'); // 手を始める前は無視
    tracker.beginStep('clone');
    expect(byId(tracker.snapshot(), 'clone-enumerate').state).toBe('running');

    expect(tracker.feed('remote: Enumerating objects: 12, done.')).toBe('structural');
    expect(byId(tracker.snapshot(), 'clone-enumerate')).toMatchObject({ state: 'done', current: 12, percent: null });

    expect(tracker.feed('remote: Counting objects:  50% (6/12)')).toBe('structural');
    expect(tracker.feed('remote: Counting objects:  75% (9/12)')).toBe('value');
    expect(byId(tracker.snapshot(), 'clone-count')).toMatchObject({ state: 'running', percent: 75 });

    // 圧縮の行が一度も来ないまま受信が始まった → 計数は完了、圧縮は省略
    expect(tracker.feed('Receiving objects:  45% (5/11), 1.20 MiB | 2.00 MiB/s')).toBe('structural');
    const mid = tracker.snapshot();
    expect(byId(mid, 'clone-count')).toMatchObject({ state: 'done', percent: 100 });
    expect(byId(mid, 'clone-compress').state).toBe('skipped');
    expect(byId(mid, 'clone-receive')).toMatchObject({ state: 'running', detail: '1.20 MiB | 2.00 MiB/s' });

    tracker.endStep('clone', 'done');
    const end = tracker.snapshot();
    expect(byId(end, 'clone-receive')).toMatchObject({ state: 'done', percent: 100 });
    expect(byId(end, 'clone-resolve').state).toBe('skipped');
    expect(byId(end, 'clone-checkout').state).toBe('skipped');
    expect(byId(end, 'clone-filter').state).toBe('skipped');
  });

  it('開始と終了の時刻が入る（所要時間の表示に使う）', () => {
    const tracker = new CloneProgressTracker('normal', clock());
    tracker.beginStep('clone');
    tracker.feed('Receiving objects: 100% (3/3), done.');
    const receive = byId(tracker.snapshot(), 'clone-receive');
    expect(receive.startedAt).not.toBeNull();
    expect((receive.endedAt ?? 0) - (receive.startedAt ?? 0)).toBeGreaterThan(0);
  });

  it('行を 1 つも受け取らずに次へ進んだ最初の段階は「省略」（ローカルパスのクローンなど）', () => {
    const tracker = new CloneProgressTracker('normal', clock());
    tracker.beginStep('clone');
    tracker.feed('Updating files: 100% (3/3), done.');

    const stages = tracker.snapshot();
    expect(byId(stages, 'clone-enumerate').state).toBe('skipped');
    expect(byId(stages, 'clone-checkout').state).toBe('done');
  });

  it('失敗すると実行中の段階が失敗になり、後ろは省略', () => {
    const tracker = new CloneProgressTracker('normal', clock());
    tracker.beginStep('clone');
    tracker.feed('Receiving objects:  45% (5/11)');
    tracker.endStep('clone', 'failed');

    const stages = tracker.snapshot();
    expect(byId(stages, 'clone-receive').state).toBe('failed');
    expect(byId(stages, 'clone-resolve').state).toBe('skipped');
  });

  it('行を出さない 1 段階だけの手は、成功すれば完了', () => {
    const tracker = new CloneProgressTracker('large', clock());
    tracker.beginStep('lfs-check');
    tracker.endStep('lfs-check', 'done');
    expect(byId(tracker.snapshot(), 'lfs-check').state).toBe('done');
  });

  it('LFS の取得行は LFS の手でだけ拾い、クローン中に来ても無視する', () => {
    const tracker = new CloneProgressTracker('large', clock());
    tracker.beginStep('clone');
    expect(tracker.feed('Downloading LFS objects:  50% (1/2), 10 MB | 5.0 MB/s')).toBe('none');
    tracker.endStep('clone', 'done');

    tracker.beginStep('lfs-pull');
    expect(tracker.feed('Downloading LFS objects:  50% (1/2), 10 MB | 5.0 MB/s')).toBe('value');
    expect(byId(tracker.snapshot(), 'lfs-pull')).toMatchObject({ state: 'running', percent: 50, total: 2 });
  });

  it('unshallow の行はクローンの段階ではなく「全履歴の」段階に入る', () => {
    const tracker = new CloneProgressTracker('large', clock());
    tracker.beginStep('unshallow');
    tracker.feed('Receiving objects:  10% (1/10)');
    const stages = tracker.snapshot();
    expect(byId(stages, 'unshallow-receive').state).toBe('running');
    expect(byId(stages, 'clone-receive').state).toBe('pending');
  });

  it('始まる前に中止された手は、すべて中止', () => {
    const tracker = new CloneProgressTracker('large', clock());
    tracker.endStep('unshallow', 'cancelled');
    expect(
      tracker
        .snapshot()
        .filter((s) => s.step === 'unshallow')
        .every((s) => s.state === 'cancelled'),
    ).toBe(true);
  });
});
