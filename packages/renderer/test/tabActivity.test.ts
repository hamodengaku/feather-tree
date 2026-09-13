import { describe, expect, it } from 'vitest';
import { TabActivity, type TabActivityOptions } from '../src/lib/tabActivity.js';

/*
 * タブの読み込み帯の発動条件（docs/01-architecture.md 8 章）のうち、時間の規則。
 *
 * 時間は短く差し替えて実時間で待つ（このリポジトリのテストは偽タイマーを使わない）。
 * この環境は時刻の刻みが粗いので、判定の前後に数十 ms の余裕を取ってある。
 */
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function activity(options: TabActivityOptions): TabActivity {
  return new TabActivity(options);
}

describe('TabActivity', () => {
  it('遅延より早く終われば帯を出さない（数十 ms の更新で点滅させない）', async () => {
    const a = activity({ delayMs: 150, minMs: 250, graceMs: 50 });

    a.begin('s1');
    await wait(40);
    a.end('s1');
    await wait(300);

    expect(a.isShown('s1')).toBe(false);
  });

  it('遅延を超えたら出し、終わっても最低表示時間までは残す', async () => {
    const a = activity({ delayMs: 100, minMs: 300, graceMs: 50 });

    a.begin('s1');
    await wait(160);
    expect(a.isShown('s1')).toBe(true);

    // 出してから約 60ms で終わる。最低表示時間（300ms）まではまだ残る
    a.end('s1');
    await wait(120);
    expect(a.isShown('s1')).toBe(true);

    await wait(250);
    expect(a.isShown('s1')).toBe(false);
  });

  it('中身がまだ無いタブは遅延なしで出す', () => {
    const a = activity({ delayMs: 1000, minMs: 1000, graceMs: 1000 });

    a.begin('s1', true);

    expect(a.isShown('s1')).toBe(true);
    a.forget('s1');
  });

  it('猶予内に再開したら同じ期間の続きとして扱い、遅延を数え直さない', async () => {
    const a = activity({ delayMs: 150, minMs: 250, graceMs: 100 });

    a.begin('s1');
    await wait(50);
    // git が終わって、反映の開始（sessionChanged の到着）を待っている隙間
    a.end('s1');
    await wait(40);
    a.begin('s1');

    // 最初の begin から数えて遅延（150ms）を過ぎた。数え直していれば、まだ出ない
    await wait(100);
    expect(a.isShown('s1')).toBe(true);
    a.forget('s1');
  });

  it('遅延が猶予の間に満了していたら、猶予内の再開で待たずに出す', async () => {
    const a = activity({ delayMs: 150, minMs: 250, graceMs: 200 });

    a.begin('s1');
    await wait(100);
    a.end('s1');
    // 遅延（150ms）は猶予の途中で満了する。落ち着いているので、まだ出さない
    await wait(100);
    expect(a.isShown('s1')).toBe(false);

    a.begin('s1');
    expect(a.isShown('s1')).toBe(true);
    a.forget('s1');
  });

  it('意図と git の和集合で判定する（どちらかが残っている間は消さない）', () => {
    const a = activity({ delayMs: 0, minMs: 0, graceMs: 0 });

    a.begin('s1');
    a.setGit('s1', true);
    a.end('s1');
    expect(a.isShown('s1')).toBe(true);

    a.setGit('s1', false);
    expect(a.isShown('s1')).toBe(false);
  });

  it('git だけでも出す（main が自発的に走らせる自動更新）', () => {
    const a = activity({ delayMs: 0, minMs: 0, graceMs: 0 });

    a.setGit('s1', true);
    expect(a.isShown('s1')).toBe(true);
    expect(a.isShown('s2')).toBe(false);

    a.setGit('s1', false);
    expect(a.isShown('s1')).toBe(false);
  });

  it('対になっていない end や、知らないタブの通知は無視する', () => {
    const a = activity({ delayMs: 0, minMs: 0, graceMs: 0 });

    a.end('s1');
    a.setGit('s1', false);
    expect(a.isShown('s1')).toBe(false);

    // 余分な end で数が負にならない（次の begin で正しく出る）
    a.begin('s1');
    expect(a.isShown('s1')).toBe(true);
    a.end('s1');
    expect(a.isShown('s1')).toBe(false);
  });

  it('タブを閉じたら即座に消し、残っていたタイマーでも復活しない', async () => {
    const a = activity({ delayMs: 60, minMs: 500, graceMs: 50 });

    a.begin('s1', true);
    a.begin('s2');
    a.forget('s1');
    a.forget('s2');
    expect(a.isShown('s1')).toBe(false);

    // 閉じた後に遅れて届いた終了通知も無害
    a.end('s1');
    await wait(120);
    expect(a.isShown('s1')).toBe(false);
    expect(a.isShown('s2')).toBe(false);
  });

  it('時間をすべて 0 にすると同期的に出入りする（AppState のテストで使う）', () => {
    const a = activity({ delayMs: 0, minMs: 0, graceMs: 0 });

    a.begin('s1');
    expect(a.isShown('s1')).toBe(true);
    a.end('s1');
    expect(a.isShown('s1')).toBe(false);
  });
});
