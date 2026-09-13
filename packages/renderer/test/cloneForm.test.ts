import { describe, expect, it } from 'vitest';
import { folderNameFromUrl, joinPreview, parentOf } from '../src/lib/cloneForm.js';

/*
 * フォルダ名の補完。入力途中に 1 文字ずつ打った状態を並べ、アドレス段階では空欄のまま、
 * パスに入ったら反映されることを確かめる（打ちかけの `.git` は隠す）。
 */
describe('folderNameFromUrl（入力途中）', () => {
  const live = (url: string): string => folderNameFromUrl(url, false);

  it.each([
    // ssh（scp 形式）: `:` を越えてから
    ['git@github.co', ''],
    ['git@github.com:', ''],
    ['git@github.com:o', 'o'],
    ['git@github.com:owner', 'owner'],
    ['git@github.com:owner/', 'owner'],
    ['git@github.com:owner/ex', 'ex'],
    ['git@github.com:owner/example', 'example'],
    ['git@github.com:owner/example.', 'example'],
    ['git@github.com:owner/example.g', 'example'],
    ['git@github.com:owner/example.gi', 'example'],
    ['git@github.com:owner/example.git', 'example'],
    // https: ホストの後ろの `/` を越えてから
    ['https:', ''],
    ['https:/', ''],
    ['https://exurl.com', ''],
    ['https://exurl.com/', ''],
    ['https://exurl.com/exowner', 'exowner'],
    ['https://exurl.com/exowner/exgroup', 'exgroup'],
    ['https://exurl.com/exowner/exgroup/example', 'example'],
    ['https://exurl.com/exowner/exgroup/example.gi', 'example'],
    ['https://exurl.com/exowner/exgroup/example.git', 'example'],
    ['https://user@exurl.com/exowner/exgroup/example.git/', 'example'],
    // ssh:// のポートの `:` はアドレス扱い
    ['ssh://git@host:22', ''],
    ['ssh://git@host:22/owner/example.git', 'example'],
    // Azure DevOps（.git が付かない形式）
    ['https://dev.azure.com/org/project/_git/example', 'example'],
    ['git@ssh.dev.azure.com:v3/org/project/example', 'example'],
    // Windows のパスと file://（ドライブ名は名前にしない）
    ['D:', ''],
    ['D:\\', ''],
    ['D:\\work', 'work'],
    ['D:\\work\\example', 'example'],
    ['file:///D:', ''],
    ['file:///D:/work/bare.git', 'bare'],
    // どの形にも当たらないものは、打っている間は補完しない
    ['\\\\server\\share\\example', ''],
    ['', ''],
  ])('%s → "%s"', (url, expected) => {
    expect(live(url)).toBe(expected);
  });

  it('前後の空白は無視する', () => {
    expect(live('  https://host/owner/日本語.git  ')).toBe('日本語');
  });

  it('フォルダ名に使えない名前は空文字', () => {
    expect(live('https://host/owner/..')).toBe('');
    expect(live('https://host/re*po')).toBe('');
  });
});

describe('folderNameFromUrl（入力の確定後）', () => {
  it('形の分からないパスは、確定したときだけ補完する', () => {
    expect(folderNameFromUrl('\\\\server\\share\\example', true)).toBe('example');
  });

  it('アドレス段階は確定しても補完しない（途中で欄を離れても崩れない）', () => {
    expect(folderNameFromUrl('git@github.co', true)).toBe('');
    expect(folderNameFromUrl('https://github.com', true)).toBe('');
    expect(folderNameFromUrl('git@github.com:', true)).toBe('');
  });

  it('打ちかけの .g は確定しても隠す（実際に example.g という名前なら手で指定する）', () => {
    expect(folderNameFromUrl('git@host:owner/example.g', true)).toBe('example');
  });
});

describe('parentOf', () => {
  it.each([
    ['D:/work/repo', 'D:/work'],
    ['D:\\work\\repo', 'D:\\work'],
    ['D:\\work\\repo\\', 'D:\\work'],
    ['D:/repo', 'D:/'],
    ['/home/user/repo', '/home/user'],
    ['/repo', '/'],
    ['repo', ''],
  ])('%s → %s', (root, expected) => {
    expect(parentOf(root)).toBe(expected);
  });
});

describe('joinPreview', () => {
  it('Windows のパスは main の join と同じく `\\` にそろえる', () => {
    expect(joinPreview('D:\\work', 'repo')).toBe('D:\\work\\repo');
    expect(joinPreview('D:/work/', 'repo')).toBe('D:\\work\\repo');
    expect(joinPreview('D:/', 'repo')).toBe('D:\\repo');
  });

  it('Windows 以外のパスは `/` のまま', () => {
    expect(joinPreview('/home/user', 'repo')).toBe('/home/user/repo');
  });

  it('どちらかが空なら空文字', () => {
    expect(joinPreview('', 'repo')).toBe('');
    expect(joinPreview('D:/work', '  ')).toBe('');
  });
});
