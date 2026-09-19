import { describe, expect, it } from 'vitest';
import { OPEN_EXECUTABLE_CONFIRMATION, isExecutableFileName } from '../../src/policy/executableFile.js';

describe('isExecutableFileName（実行されうるファイルの判定、脆弱性診断 §5）', () => {
  it('代表的な実行可能拡張子を検出する', () => {
    for (const name of [
      'malware.exe',
      'legacy.com',
      'screensaver.scr',
      'old.pif',
      'run.bat',
      'run.cmd',
      'installer.msi',
      'patch.msp',
      'console.msc',
      'panel.cpl',
      'settings.reg',
      'shortcut.lnk',
      'link.url',
      'app.appref-ms',
      'script.ps1',
      'module.psm1',
      'script.vbs',
      'script.vbe',
      'script.js',
      'script.jse',
      'script.wsf',
      'script.wsh',
      'app.hta',
      'plugin.jar',
      'help.chm',
      'driver.inf',
      'shell.scf',
      'script.sct',
      'help.hlp',
      'cert.cer',
      'shell.msh',
      'shell.msh1',
      'shell.msh2',
      'shell.mshxml',
      'shell.msh1xml',
      'shell.msh2xml',
    ]) {
      expect(isExecutableFileName(name)).toBe(true);
    }
  });

  it('大文字小文字を無視する', () => {
    expect(isExecutableFileName('MALWARE.EXE')).toBe(true);
    expect(isExecutableFileName('Setup.Msi')).toBe(true);
  });

  it('無害な拡張子は対象外', () => {
    for (const name of ['README.md', 'photo.png', 'data.json', 'notes.txt', 'archive.zip']) {
      expect(isExecutableFileName(name)).toBe(false);
    }
  });

  it('拡張子が無い名前・拡張子だけの名前（隠しファイル的な名前）は対象外', () => {
    expect(isExecutableFileName('Makefile')).toBe(false);
    expect(isExecutableFileName('.gitignore')).toBe(false);
    expect(isExecutableFileName('.exe')).toBe(false);
  });

  it('複合拡張子は最後の拡張子だけを見る（readme.txt.exe を取りこぼさない）', () => {
    expect(isExecutableFileName('readme.txt.exe')).toBe(true);
    // 逆方向（無害な拡張子で終わる複合名）は対象外のままでよい
    expect(isExecutableFileName('installer.exe.txt')).toBe(false);
  });

  it('末尾の空白・ドットは Windows が無視するため、判定でも無視する', () => {
    expect(isExecutableFileName('malware.exe.')).toBe(true);
    expect(isExecutableFileName('malware.exe ')).toBe(true);
    expect(isExecutableFileName('malware.exe. . ')).toBe(true);
    expect(isExecutableFileName('malware.exe...')).toBe(true);
  });

  it('確認内容は開くことを既定にしない（recoverable: false で強い警告を出させる）', () => {
    expect(OPEN_EXECUTABLE_CONFIRMATION.recoverable).toBe(false);
    expect(OPEN_EXECUTABLE_CONFIRMATION.action).toBe('open-executable-file');
    expect(OPEN_EXECUTABLE_CONFIRMATION.message).toContain('信頼できる場合だけ');
  });
});
