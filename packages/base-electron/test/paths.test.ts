import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInstalledBuild } from '../src/index.js';

const EXE_DIR = 'C:/Program Files/MyApp';

describe('isInstalledBuild（インストール版 / zip 展開版の判定）', () => {
  it('exe の隣にアンインストーラがあればインストール版と判定する', () => {
    const uninstaller = join(EXE_DIR, 'Uninstall MyApp.exe');
    const exists = (path: string): boolean => path === uninstaller;
    expect(isInstalledBuild(EXE_DIR, 'Uninstall MyApp.exe', exists)).toBe(true);
  });

  it('アンインストーラが無ければ zip 展開版と判定する', () => {
    const exists = (): boolean => false;
    expect(isInstalledBuild(EXE_DIR, 'Uninstall MyApp.exe', exists)).toBe(false);
  });

  it('release/win-unpacked にはアンインストーラが無いので zip 版扱いになる', () => {
    // win-unpacked はアンインストーラが生成されない（NSIS を経由していないため）
    const exists = (): boolean => false;
    expect(isInstalledBuild('D:/repo/release/win-unpacked', 'Uninstall FeatherTree.exe', exists)).toBe(false);
  });

  it('別のアプリのアンインストーラ名では一致しない', () => {
    const other = join(EXE_DIR, 'Uninstall OtherApp.exe');
    const exists = (path: string): boolean => path === other;
    expect(isInstalledBuild(EXE_DIR, 'Uninstall MyApp.exe', exists)).toBe(false);
  });

  it('exists を注入しない場合は実ファイルシステムを見る（既定値が existsSync であることの確認）', () => {
    // 存在し得ないパスなので false になるはず
    expect(isInstalledBuild('D:/does/not/exist', 'Uninstall Nothing.exe')).toBe(false);
  });
});
