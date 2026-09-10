import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { CHANNELS } from '@feathertree/ipc';
import type { AppContext } from '../appContext.js';
import { wrap } from '../errors.js';
import { createService, type Service } from './service.js';

/**
 * ipcMain とサービスを繋ぐだけの薄い層。
 * ロジックは service.ts にあり、そちらは Electron なしでテストできる。
 */
export function registerHandlers(ctx: AppContext, getWindow: () => BrowserWindow | null): void {
  const service = createService({
    appInfo: () => ({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      userDataDir: ctx.userDataDir,
      isPackaged: app.isPackaged,
    }),
    git: () => ctx.git,
    gitVersion: () => ctx.gitVersion,
    settings: () => ctx.currentSettings(),
    updateSettings: (patch) => ctx.settings.update(patch),
    reloadGit: () => ctx.reloadGit(),
    sessions: () => ctx.sessions(),
    commandLog: () => ctx.commandLog,
    pickDirectory: async () => {
      const window = getWindow();
      const options = { properties: ['openDirectory' as const] };
      const result =
        window === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(window, options);
      const picked = result.filePaths[0];
      return result.canceled || picked === undefined ? null : picked;
    },
  });

  const bind = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void => {
    ipcMain.handle(channel, (_event, ...args: A) => wrap(() => fn(...args)));
  };

  bind(CHANNELS.appGetInfo, () => service.appGetInfo());
  bind(CHANNELS.appGetEnvironment, () => service.appGetEnvironment());
  bind(CHANNELS.settingsGet, () => service.settingsGet());
  bind(CHANNELS.settingsUpdate, (patch: Parameters<Service['settingsUpdate']>[0]) =>
    service.settingsUpdate(patch),
  );

  bind(CHANNELS.sessionPickAndOpen, () => service.sessionPickAndOpen());
  bind(CHANNELS.sessionOpen, (root: string) => service.sessionOpen(root));
  bind(CHANNELS.sessionList, () => service.sessionList());
  bind(CHANNELS.sessionActivate, (id: string) => service.sessionActivate(id));
  bind(CHANNELS.sessionClose, (id: string) => service.sessionClose(id));
  bind(CHANNELS.sessionRefresh, (id: string, scope: Parameters<Service['sessionRefresh']>[1]) =>
    service.sessionRefresh(id, scope),
  );
  bind(CHANNELS.sessionReorder, (order: readonly string[]) => service.sessionReorder(order));

  bind(CHANNELS.statusGetSummary, (id: string) => service.statusGetSummary(id));
  bind(CHANNELS.statusGetPage, (id: string, req: Parameters<Service['statusGetPage']>[1]) =>
    service.statusGetPage(id, req),
  );

  bind(CHANNELS.stage, (id: string, target: Parameters<Service['stage']>[1]) => service.stage(id, target));
  bind(CHANNELS.unstage, (id: string, target: Parameters<Service['unstage']>[1]) =>
    service.unstage(id, target),
  );
  bind(
    CHANNELS.discard,
    (id: string, target: Parameters<Service['discard']>[1], confirmed?: boolean) =>
      service.discard(id, target, confirmed),
  );
  bind(
    CHANNELS.deleteUntracked,
    (id: string, target: Parameters<Service['deleteUntracked']>[1], confirmed?: boolean) =>
      service.deleteUntracked(id, target, confirmed),
  );
  bind(CHANNELS.commit, (id: string, req: Parameters<Service['commit']>[1], confirmed?: boolean) =>
    service.commit(id, req, confirmed),
  );

  bind(CHANNELS.diffGet, (id: string, path: string, staged: boolean) =>
    service.diffGet(id, path, staged),
  );
  bind(CHANNELS.logGetPage, (id: string, skip: number) => service.logGetPage(id, skip));
  bind(CHANNELS.branchList, (id: string) => service.branchList(id));
  bind(CHANNELS.branchSwitch, (id: string, branchName: string) => service.branchSwitch(id, branchName));
  bind(CHANNELS.branchCreate, (id: string, req: Parameters<Service['branchCreate']>[1]) =>
    service.branchCreate(id, req),
  );
  bind(CHANNELS.commandLogRecent, (limit: number) => service.commandLogRecent(limit));
}
