/**
 * 更新通知（決定 29）の IPC ハンドラ。
 *
 * register.ts は編集対象外（並行編集中）なので、この機能だけ別ファイルに置き、
 * index.ts から呼ぶ。ipcMain とサービス相当のロジックをこの 1 ファイルにまとめてある
 * （register.ts + service.ts に相当するものを、この機能専用に 1 本化した形）。
 */
import { app, ipcMain, net, shell, type BrowserWindow } from 'electron';
import { CHANNELS, type UpdateStateDto } from '@feathertree/ipc';
import {
  STARTUP_UPDATE_CHECK_DELAY_MS,
  autoCheckIfDue,
  buildReleasePageUrl,
  checkNow,
  fetchLatestReleaseJson,
  isValidReleasePageUrl,
  type UpdateCheckDeps,
  type UpdateCheckResult,
} from '../updateCheck.js';
import type { AppContext } from '../appContext.js';
import { wrap } from '../errors.js';

const USER_AGENT_PREFIX = 'FeatherTree/';

export interface UpdateHandlers {
  /**
   * 起動時の自動確認。決定 28 の起動を遅らせないため、
   * index.ts が本体ウィンドウの表示後に（数秒待ってから）呼ぶ。
   */
  runStartupCheck(): Promise<void>;
}

/**
 * ipcMain とサービスを繋ぐ薄い層 + 更新確認の状態保持。
 *
 * 状態（直近の結果・通知中の版の検証済み tag）はこのクロージャの中だけに置く。
 * AppContext には持たせない（他機能から触られる理由が無いものを共有状態に混ぜない）。
 */
export function registerUpdateHandlers(ctx: AppContext, getWindow: () => BrowserWindow | null): UpdateHandlers {
  /** 直近の確認結果。renderer が起動直後で購読前でも updateGetState で取り直せるようにする。 */
  let lastResult: UpdateCheckResult | null = null;
  /**
   * updateOpenReleasePage が使う tag。**必ず parseReleaseTag を通ったものだけ**を入れる
   * （UpdateCheckResult.tag は evaluateLatestRelease が既に検証済みだが、
   * 「通知中の新版が無ければ null」という別条件もここで一緒に持たせる）。
   */
  let validatedTag: string | null = null;

  const deps: UpdateCheckDeps = {
    fetchRelease: () => fetchLatestReleaseJson(net.fetch, USER_AGENT_PREFIX + app.getVersion()),
    currentVersion: () => app.getVersion(),
    now: () => Date.now(),
    getSettings: () => ctx.currentSettings(),
    setLastCheckedAt: async (at) => {
      await ctx.settings.update({ lastUpdateCheckAt: at });
    },
  };

  const applyResult = (result: UpdateCheckResult): void => {
    lastResult = result;
    validatedTag = result.outcome === 'new-version' ? result.tag : null;
  };

  const notifyIfNew = (result: UpdateCheckResult): void => {
    if (result.outcome !== 'new-version' || result.version === null) return;
    const window = getWindow();
    if (window === null || window.isDestroyed()) return;
    window.webContents.send(CHANNELS.eventUpdateAvailable, { version: result.version });
  };

  const toStateDto = (): UpdateStateDto => ({
    outcome: lastResult?.outcome ?? 'unknown',
    version: lastResult?.outcome === 'new-version' ? lastResult.version : null,
  });

  ipcMain.handle(CHANNELS.updateGetState, () => wrap(() => toStateDto()));

  ipcMain.handle(CHANNELS.updateCheckNow, () =>
    wrap(async () => {
      const result = await checkNow(deps);
      applyResult(result);
      notifyIfNew(result);
      return toStateDto();
    }),
  );

  ipcMain.handle(CHANNELS.updateOpenReleasePage, () =>
    wrap(async () => {
      // 通知中の新版が無ければ何もしない（renderer からは tag も URL も受け取らない）
      if (validatedTag === null) return;
      const url = buildReleasePageUrl(validatedTag);
      // shell.openExternal に渡す直前の再検証（決定 29）。ここで弾かれるのは実装上の事故だけのはず
      if (url === null || !isValidReleasePageUrl(url)) return;
      await shell.openExternal(url);
    }),
  );

  ipcMain.handle(CHANNELS.updateDismiss, () =>
    wrap(async () => {
      if (lastResult?.outcome !== 'new-version' || lastResult.version === null) return;
      await ctx.settings.update({ dismissedUpdateVersion: lastResult.version });
    }),
  );

  return {
    runStartupCheck: async () => {
      const result = await autoCheckIfDue(deps);
      // shouldCheck が false でスキップしたときは何もしない（lastResult は 'unknown' のまま残る）
      if (result === null) return;
      applyResult(result);
      notifyIfNew(result);
    },
  };
}

export { STARTUP_UPDATE_CHECK_DELAY_MS };
