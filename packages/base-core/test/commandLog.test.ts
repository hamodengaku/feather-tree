import { describe, expect, it } from 'vitest';
import { CommandLog } from '../src/diagnostics/commandLog.js';

describe('CommandLog', () => {
  const entry = (args: string[], scope?: string) => ({
    cwd: 'D:/repo',
    args,
    exitCode: 0,
    elapsedMs: 1,
    ...(scope === undefined ? {} : { scope }),
  });

  it('新しい順に返し、容量を超えたら古いものから捨てる', () => {
    const log = new CommandLog(2);
    log.add(entry(['a']));
    log.add(entry(['b']));
    log.add(entry(['c']));

    expect(log.recent().map((e) => e.args[0])).toEqual(['c', 'b']);
    expect(log.size).toBe(2);
  });

  it('まとまりの識別子（scope）をそのまま残す。無ければ付かない', () => {
    const log = new CommandLog();
    log.add(entry(['status'], 'tab-1'));
    log.add(entry(['clone']));

    const [clone, status] = log.recent();
    expect(status?.scope).toBe('tab-1');
    expect(clone !== undefined && 'scope' in clone).toBe(false);
  });

  it('追記のたびに購読者へ採番済みの記録を渡し、解除後は呼ばない', () => {
    const log = new CommandLog();
    const seen: number[] = [];
    const unsubscribe = log.onAdd((e) => seen.push(e.seq));

    log.add(entry(['a']));
    log.add(entry(['b']));
    unsubscribe();
    log.add(entry(['c']));

    expect(seen).toEqual([1, 2]);
  });

  it('購読者が投げても記録は残り、他の購読者にも届く', () => {
    const log = new CommandLog();
    const seen: string[] = [];
    log.onAdd(() => {
      throw new Error('boom');
    });
    log.onAdd((e) => seen.push(e.args[0] ?? ''));

    expect(() => log.add(entry(['a']))).not.toThrow();
    expect(log.size).toBe(1);
    expect(seen).toEqual(['a']);
  });
});
