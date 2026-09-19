import { describe, expect, it } from 'vitest';
import type { BrowserWindow } from 'electron';
import { hardenWindow } from '../src/security.js';

/**
 * BrowserWindow は Electron 無しでは作れないので、`webContents.session` の
 * setPermissionRequestHandler / setPermissionCheckHandler に渡された関数だけを
 * 直接取り出して検証する（will-navigate 等は既存の動作で対象外）。
 */
function createFakeWindow(): {
  window: BrowserWindow;
  permissionRequestHandler: (permission: string) => boolean;
  permissionCheckHandler: (permission: string) => boolean;
} {
  let requestHandler: ((wc: unknown, permission: string, callback: (granted: boolean) => void) => void) | undefined;
  let checkHandler: ((wc: unknown, permission: string) => boolean) | undefined;

  const fakeWindow = {
    webContents: {
      getURL: () => 'file:///index.html',
      on: () => undefined,
      setWindowOpenHandler: () => undefined,
      session: {
        setPermissionRequestHandler: (
          handler: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void,
        ) => {
          requestHandler = handler;
        },
        setPermissionCheckHandler: (handler: (wc: unknown, permission: string) => boolean) => {
          checkHandler = handler;
        },
      },
    },
  } as unknown as BrowserWindow;

  hardenWindow(fakeWindow);

  return {
    window: fakeWindow,
    permissionRequestHandler: (permission: string) => {
      let granted = false;
      requestHandler?.(undefined, permission, (result) => {
        granted = result;
      });
      return granted;
    },
    permissionCheckHandler: (permission: string) => checkHandler?.(undefined, permission) ?? false,
  };
}

describe('hardenWindow の権限要求ハンドラ（クリップボード書き込みのみ許可）', () => {
  it('clipboard-sanitized-write は許可する（コピーボタンが使う）', () => {
    const { permissionRequestHandler, permissionCheckHandler } = createFakeWindow();
    expect(permissionRequestHandler('clipboard-sanitized-write')).toBe(true);
    expect(permissionCheckHandler('clipboard-sanitized-write')).toBe(true);
  });

  it.each(['clipboard-read', 'media', 'geolocation', 'notifications', 'camera', 'microphone', 'unknown'])(
    '%s は拒否する',
    (permission) => {
      const { permissionRequestHandler, permissionCheckHandler } = createFakeWindow();
      expect(permissionRequestHandler(permission)).toBe(false);
      expect(permissionCheckHandler(permission)).toBe(false);
    },
  );

  it('同じ session に対して 2 回呼んでも（スプラッシュ + 本体）判定は変わらない', () => {
    let requestHandler: ((wc: unknown, permission: string, callback: (granted: boolean) => void) => void) | undefined;
    let checkHandler: ((wc: unknown, permission: string) => boolean) | undefined;
    const sharedSession = {
      setPermissionRequestHandler: (
        handler: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void,
      ) => {
        requestHandler = handler;
      },
      setPermissionCheckHandler: (handler: (wc: unknown, permission: string) => boolean) => {
        checkHandler = handler;
      },
    };
    const makeWindow = (): BrowserWindow =>
      ({
        webContents: {
          getURL: () => 'file:///index.html',
          on: () => undefined,
          setWindowOpenHandler: () => undefined,
          session: sharedSession,
        },
      }) as unknown as BrowserWindow;

    hardenWindow(makeWindow()); // スプラッシュ
    hardenWindow(makeWindow()); // 本体

    let granted = false;
    requestHandler?.(undefined, 'clipboard-sanitized-write', (result) => {
      granted = result;
    });
    expect(granted).toBe(true);
    expect(checkHandler?.(undefined, 'geolocation')).toBe(false);
  });
});
