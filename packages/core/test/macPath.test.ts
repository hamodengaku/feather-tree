import { describe, expect, it } from 'vitest';
import { augmentPathForMac } from '../src/index.js';

/*
 * macOS を Finder / Dock から起動したときの PATH 補完。
 * Homebrew の置き場が欠けていると git / git-lfs が見つからないので、先頭に足す。
 */
describe('augmentPathForMac', () => {
  const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

  it('macOS で Homebrew の置き場が無ければ先頭に足す', () => {
    expect(augmentPathForMac(GUI_PATH, 'darwin')).toBe('/opt/homebrew/bin:/usr/local/bin:' + GUI_PATH);
  });

  it('既にあるものは足さず、並びも変えない（ターミナルから起動した場合）', () => {
    const shellPath = '/opt/homebrew/bin:/usr/local/bin:' + GUI_PATH;
    expect(augmentPathForMac(shellPath, 'darwin')).toBe(shellPath);
  });

  it('片方だけ欠けていれば、欠けているほうだけを足す', () => {
    expect(augmentPathForMac('/usr/local/bin:/usr/bin', 'darwin')).toBe(
      '/opt/homebrew/bin:/usr/local/bin:/usr/bin',
    );
  });

  it('PATH が無い・空でも落ちない', () => {
    expect(augmentPathForMac(undefined, 'darwin')).toBe('/opt/homebrew/bin:/usr/local/bin');
    expect(augmentPathForMac('', 'darwin')).toBe('/opt/homebrew/bin:/usr/local/bin');
  });

  it('macOS 以外では何も変えない', () => {
    expect(augmentPathForMac('C:\\Windows;C:\\tools', 'win32')).toBe('C:\\Windows;C:\\tools');
    expect(augmentPathForMac(undefined, 'win32')).toBeUndefined();
    expect(augmentPathForMac(GUI_PATH, 'linux')).toBe(GUI_PATH);
  });
});
