import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { CHANNELS } from '@feathertree/ipc';
import { applyTitleBarOverlay } from '@feathertree/base-electron';
import { locateTerminal } from '@feathertree/core';
import type { AppContext } from '../appContext.js';
import { wrap } from '../errors.js';
import { chromeFor } from '../windowChrome.js';
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
    sshPath: () => ctx.sshPath,
    settings: () => ctx.currentSettings(),
    /*
     * キャプション領域（OS が描く ─ □ ×）は CSS の外にあるので、テーマを変えても勝手には
     * 追従しない。設定更新を通る唯一の経路であるここで塗り直す。
     * service.ts 側ではなくここに置くのは、あちらを Electron 非依存に保つため。
     */
    updateSettings: async (patch) => {
      const updated = await ctx.settings.update(patch);
      applyTitleBarOverlay(getWindow(), chromeFor(updated.theme));
      return updated;
    },
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
    /*
     * 設定画面のファイル選択（決定 7 の git.exe 指定、決定 13 追記の SSH 鍵指定）。
     *
     * renderer からはフィルタも初期フォルダも受け取らず、用途だけで main が決める
     * （pickDirectory が openDirectory を固定しているのと同じ思想）。
     * 秘密鍵は拡張子を持たない（id_ed25519）のでフィルタを掛けず、代わりに
     * 隠しファイルを見せる——macOS / Linux の ~/.ssh は showHiddenFiles が無いと辿れない。
     */
    pickFile: async (kind) => {
      const window = getWindow();
      const options =
        kind === 'git-executable'
          ? {
              title: 'git.exe を選択',
              properties: ['openFile' as const],
              filters: [{ name: 'git', extensions: ['exe'] }],
            }
          : {
              title: 'SSH 秘密鍵を選択',
              defaultPath: join(app.getPath('home'), '.ssh'),
              properties: ['openFile' as const, 'showHiddenFiles' as const],
            };
      const result =
        window === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(window, options);
      const picked = result.filePaths[0];
      return result.canceled || picked === undefined ? null : picked;
    },
    notifyCloneProgress: (event) => {
      const window = getWindow();
      if (window === null || window.isDestroyed()) return;
      window.webContents.send(CHANNELS.eventCloneProgress, event);
    },
    openPath: (absolutePath) => shell.openPath(absolutePath),
    showItemInFolder: (absolutePath) => {
      shell.showItemInFolder(absolutePath);
    },
    resolveTerminal: (cwd) =>
      locateTerminal({ env: process.env, cwd, gitPath: ctx.git?.gitPath ?? null }),

    /*
     * ターミナルの起動（決定 26）。
     *
     * shell: false + 引数配列。コマンド文字列は組み立てない（決定 6 と同じ理由で、
     * 引用符とスペースの事故を根本から避ける）。
     * detached + unref でアプリから切り離す。付けないとアプリ終了時に道連れになり、
     * windowsHide も false でなければコンソールの窓が出ない。
     * stdio を捨てるのは、相手の出力を読む気が無いため（読まないパイプは詰まる）。
     */
    launchTerminal: (launch, cwd) => {
      // locateTerminal は必ず絶対パスを返す契約（1-A）。相対パス・bare 名で spawn すると
      // Windows の libuv が cwd（リポジトリルート）を PATH より先に検索してしまうため、
      // 契約違反を検知したらここで落とす（起動しない）。実装ミスの検出を兼ねた防御的二重チェック。
      if (!isAbsolute(launch.exe)) {
        throw new Error('ターミナルの起動先が絶対パスではありません: ' + launch.exe);
      }
      const child = spawn(launch.exe, [...launch.args], {
        cwd,
        shell: false,
        detached: true,
        windowsHide: false,
        stdio: 'ignore',
      });
      // 起動に失敗しても本体は動き続ける。握り潰さないと unhandled になる。
      child.on('error', () => undefined);
      child.unref();
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
  bind(CHANNELS.dialogPickFile, (kind: Parameters<Service['dialogPickFile']>[0]) =>
    service.dialogPickFile(kind),
  );
  bind(CHANNELS.gitConfigGetIdentity, (id: string) => service.gitConfigGetIdentity(id));
  bind(CHANNELS.gitConfigSetIdentity, (id: string, req: Parameters<Service['gitConfigSetIdentity']>[1]) =>
    service.gitConfigSetIdentity(id, req),
  );
  bind(CHANNELS.sshSetKey, (id: string, keyPath: string | null) => service.sshSetKey(id, keyPath));

  bind(CHANNELS.sessionPickAndCreate, () => service.sessionPickAndCreate());
  bind(CHANNELS.sessionLoad, (id: string) => service.sessionLoad(id));
  bind(CHANNELS.sessionOpen, (root: string) => service.sessionOpen(root));
  bind(CHANNELS.clonePickDirectory, () => service.clonePickDirectory());
  bind(CHANNELS.sessionCloneAndCreate, (req: Parameters<Service['sessionCloneAndCreate']>[0]) =>
    service.sessionCloneAndCreate(req),
  );
  bind(CHANNELS.cloneCancel, () => service.cloneCancel());
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
  bind(CHANNELS.stageHunks, (id: string, req: Parameters<Service['stageHunks']>[1]) =>
    service.stageHunks(id, req),
  );
  bind(CHANNELS.unstageHunks, (id: string, req: Parameters<Service['unstageHunks']>[1]) =>
    service.unstageHunks(id, req),
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
  bind(CHANNELS.conflictGet, (id: string, path: string) => service.conflictGet(id, path));
  bind(CHANNELS.unityGetView, (id: string, path: string, staged: boolean) =>
    service.unityGetView(id, path, staged),
  );
  bind(CHANNELS.unityGetNode, (id: string, path: string, staged: boolean, nodeId: string) =>
    service.unityGetNode(id, path, staged, nodeId),
  );
  bind(CHANNELS.unityIndexScripts, (id: string) => service.unityIndexScripts(id));
  bind(CHANNELS.conflictResolve, (id: string, req: Parameters<Service['conflictResolve']>[1]) =>
    service.conflictResolve(id, req),
  );
  bind(CHANNELS.logGetPage, (id: string, skip: number) => service.logGetPage(id, skip));
  bind(CHANNELS.commitGetFiles, (id: string, oid: string) => service.commitGetFiles(id, oid));
  bind(CHANNELS.commitGetDiff, (id: string, oid: string, path: string) =>
    service.commitGetDiff(id, oid, path),
  );
  bind(CHANNELS.branchList, (id: string) => service.branchList(id));
  bind(CHANNELS.branchSwitch, (id: string, branchName: string) => service.branchSwitch(id, branchName));
  bind(CHANNELS.branchCreate, (id: string, req: Parameters<Service['branchCreate']>[1]) =>
    service.branchCreate(id, req),
  );
  bind(CHANNELS.branchMerge, (id: string, branchName: string, confirmed?: boolean) =>
    service.branchMerge(id, branchName, confirmed),
  );
  bind(CHANNELS.stashList, (id: string) => service.stashList(id));
  bind(CHANNELS.stashSave, (id: string, message: string) => service.stashSave(id, message));
  bind(CHANNELS.stashApply, (id: string, req: Parameters<Service['stashApply']>[1]) =>
    service.stashApply(id, req),
  );
  bind(CHANNELS.stashDrop, (id: string, stash: Parameters<Service['stashDrop']>[1], confirmed?: boolean) =>
    service.stashDrop(id, stash, confirmed),
  );
  bind(CHANNELS.stashGetFiles, (id: string, stash: Parameters<Service['stashGetFiles']>[1]) =>
    service.stashGetFiles(id, stash),
  );
  bind(CHANNELS.stashGetDiff, (id: string, stash: Parameters<Service['stashGetDiff']>[1], path: string) =>
    service.stashGetDiff(id, stash, path),
  );

  bind(CHANNELS.remoteList, (id: string) => service.remoteList(id));
  bind(CHANNELS.remoteFetch, (id: string, remote: string) => service.remoteFetch(id, remote));
  bind(CHANNELS.remotePull, (id: string) => service.remotePull(id));
  bind(CHANNELS.remotePush, (id: string, req: Parameters<Service['remotePush']>[1]) =>
    service.remotePush(id, req),
  );

  bind(CHANNELS.shellOpenPath, (id: string, path: string, confirmed?: boolean) =>
    service.shellOpenPath(id, path, confirmed),
  );
  bind(CHANNELS.shellShowInFolder, (id: string, path: string) =>
    service.shellShowInFolder(id, path),
  );
  bind(CHANNELS.shellOpenTerminal, (id: string) => service.shellOpenTerminal(id));
  bind(CHANNELS.commandLogRecent, (limit: number) => service.commandLogRecent(limit));
}
