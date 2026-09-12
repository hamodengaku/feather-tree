import { describe, expect, it } from 'vitest';
import { TAB_SUBJECT_CHARS, branchLeaf, truncateSubject } from '../src/lib/tabLabel.js';

/*
 * リポジトリタブのラベル（決定 24）。
 *
 * どちらも「境界でどうなるか」が目で確かめにくいので、ここで固定しておく。
 */

describe('branchLeaf', () => {
  it('スラッシュの最終セグメントだけを返す', () => {
    expect(branchLeaf('hamodengaku/test/test')).toBe('test');
    expect(branchLeaf('feature/ui')).toBe('ui');
  });

  it('スラッシュを含まない名前はそのまま', () => {
    expect(branchLeaf('main')).toBe('main');
  });

  it('末尾や連続したスラッシュに引きずられない（空のセグメントを拾わない）', () => {
    expect(branchLeaf('feature/ui/')).toBe('ui');
    expect(branchLeaf('feature//ui')).toBe('ui');
  });

  it('スラッシュだけ・空文字なら元の文字列を返す（空を出して丸が潰れないように）', () => {
    expect(branchLeaf('/')).toBe('/');
    expect(branchLeaf('')).toBe('');
  });
});

describe('truncateSubject', () => {
  it('上限以下なら手を付けない', () => {
    expect(truncateSubject('短い件名')).toBe('短い件名');
    expect(truncateSubject('')).toBe('');
  });

  it('ちょうど上限の長さでは … を付けない', () => {
    const exact = 'あ'.repeat(TAB_SUBJECT_CHARS);
    expect(truncateSubject(exact)).toBe(exact);
  });

  it('上限を 1 文字超えたら打ち切って … を付ける', () => {
    expect(truncateSubject('あ'.repeat(TAB_SUBJECT_CHARS + 1))).toBe(
      'あ'.repeat(TAB_SUBJECT_CHARS) + '…',
    );
  });

  it('既定は 10 文字', () => {
    expect(truncateSubject('レイアウト刷新／fetch,pull,push追加')).toBe('レイアウト刷新／fe…');
  });

  /*
   * String.length は UTF-16 の単位数なので、絵文字はサロゲートペアの途中で切れて壊れる。
   * gitmoji を使う人のコミットメッセージで実際に踏む。
   */
  it('絵文字をサロゲートペアの途中で切らない', () => {
    const subject = '🎨'.repeat(12);
    const result = truncateSubject(subject);

    expect(result).toBe('🎨'.repeat(TAB_SUBJECT_CHARS) + '…');
    /*
     * 壊れた片割れ（孤立サロゲート）が残っていないこと。
     * Array.from はコードポイント単位で回すので、対になっていないサロゲートだけが
     * 1 文字として U+D800〜U+DFFF の範囲に現れる。
     */
    const lone = Array.from(result).filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code >= 0xd800 && code <= 0xdfff;
    });
    expect(lone).toEqual([]);
  });

  it('上限を指定できる', () => {
    expect(truncateSubject('abcdef', 3)).toBe('abc…');
    expect(truncateSubject('abc', 3)).toBe('abc');
  });
});
