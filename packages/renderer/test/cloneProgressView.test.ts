import { describe, expect, it } from 'vitest';
import type { CloneOutcomeDto, CloneStageDto } from '@feathertree/ipc';
import {
  barText,
  formatCount,
  formatDuration,
  headingBefore,
  outcomeHeading,
  showsLog,
  stageTime,
} from '../src/lib/cloneProgressView.js';

function stage(over: Partial<CloneStageDto> = {}): CloneStageDto {
  return {
    id: 'clone-receive',
    label: 'データの受信',
    source: 'Receiving objects',
    group: 'clone',
    step: 'clone',
    state: 'pending',
    percent: null,
    current: null,
    total: null,
    detail: null,
    startedAt: null,
    endedAt: null,
    ...over,
  };
}

function outcome(over: Partial<CloneOutcomeDto> = {}): CloneOutcomeDto {
  return {
    result: 'succeeded',
    cancelled: false,
    session: { id: 's4', root: 'D:/work/game', displayName: 'game' },
    target: 'D:\\work\\game',
    stages: [],
    hints: [],
    followUps: [],
    log: 'log',
    ...over,
  };
}

describe('formatDuration', () => {
  it.each([
    [0, '0秒'],
    [12_400, '12秒'],
    [184_000, '3分04秒'],
    [3_725_000, '1時間02分'],
    [-5, '0秒'],
  ])('%d ms → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('barText', () => {
  it('%・件数・転送量をつなぐ', () => {
    expect(barText(stage({ percent: 45, current: 12345, total: 40000, detail: '1.20 MiB | 2.00 MiB/s' }))).toBe(
      '45% ・ 12,345 / 40,000 ・ 1.20 MiB | 2.00 MiB/s',
    );
  });

  it('件数だけの段階（Enumerating objects）', () => {
    expect(barText(stage({ current: 1234567 }))).toBe('1,234,567 件');
  });

  it('何も無ければ空', () => {
    expect(barText(stage())).toBe('');
    expect(formatCount(999)).toBe('999');
  });
});

describe('stageTime', () => {
  it('実行中は経過、閉じた段階は所要、始まっていなければ空', () => {
    expect(stageTime(stage({ state: 'running', startedAt: 1000 }), 6000)).toBe('5秒');
    expect(stageTime(stage({ state: 'done', startedAt: 1000, endedAt: 64_000 }), 999_999)).toBe('1分03秒');
    expect(stageTime(stage({ state: 'skipped' }), 5000)).toBe('');
  });
});

describe('headingBefore', () => {
  it('まとまりの変わり目にだけ見出しを出す', () => {
    const stages = [
      stage({ id: 'a', group: 'clone' }),
      stage({ id: 'b', group: 'clone' }),
      stage({ id: 'c', group: 'lfs' }),
      stage({ id: 'd', group: 'unshallow' }),
    ];
    expect(stages.map((_, i) => headingBefore(stages, i))).toEqual(['クローン', null, 'Git LFS', '全履歴の取得']);
  });
});

describe('outcomeHeading / showsLog', () => {
  it('結果ごとの見出し', () => {
    expect(outcomeHeading(outcome())).toBe('完了しました');
    expect(outcomeHeading(outcome({ result: 'partial' }))).toBe('一部の手順が失敗しました（タブは開きました）');
    expect(outcomeHeading(outcome({ result: 'failed', session: null }))).toBe('失敗しました');
    expect(outcomeHeading(outcome({ result: 'failed', cancelled: true, session: null }))).toBe('中止しました');
    expect(outcomeHeading(outcome({ result: 'partial', cancelled: true }))).toBe('中止しました（タブは開きました）');
  });

  it('生ログのコピーは、失敗・途中失敗・中止のときだけ', () => {
    expect(showsLog(outcome())).toBe(false);
    expect(showsLog(outcome({ result: 'failed', session: null }))).toBe(true);
    expect(showsLog(outcome({ result: 'partial' }))).toBe(true);
    expect(showsLog(outcome({ result: 'partial', cancelled: true }))).toBe(true);
    expect(showsLog(outcome({ result: 'failed', log: '' }))).toBe(false);
  });
});
