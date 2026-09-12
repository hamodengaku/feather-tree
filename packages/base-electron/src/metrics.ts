import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 起動時間を JSON に書き出す。
 *
 * 土台としての意図: 配布物の起動時間を**外から機械的に計測できる**ようにする。
 * パッケージ済みアプリはコンソールに出力できないので、userData 配下のファイルで受け渡す。
 * `scripts/measure.mjs` がこれを読む。
 *
 * 計測は失敗しても本体の動作に影響させない（try/catch で握りつぶす）。
 */
export interface StartupMetrics {
  /** プロセス開始から app.ready まで。 */
  readonly appReadyMs: number;
  /** プロセス開始からウィンドウ表示可能まで。 */
  readonly readyToShowMs: number;
  /**
   * プロセス開始からスプラッシュ表示まで。スプラッシュを出さない構成なら省略する。
   * 「押した」の合図が出るまでの時間で、体感の起動の速さはここで決まる。
   */
  readonly splashShownMs?: number;
  /**
   * プロセス開始から本体ウィンドウが**実際に見える**まで。
   *
   * `readyToShowMs` は「表示できるようになった時刻」で、スプラッシュの最低表示時間が
   * あると実際に見える時刻とは別物になる。両方を取って混同しないようにする。
   */
  readonly windowShownMs?: number;
}

export const STARTUP_METRICS_FILE = 'startup-metrics.json';

export function writeStartupMetrics(userDataDir: string, metrics: StartupMetrics): void {
  try {
    writeFileSync(
      join(userDataDir, STARTUP_METRICS_FILE),
      JSON.stringify({ ...metrics, at: new Date().toISOString() }, null, 2),
    );
  } catch {
    // 計測は失敗しても本体の動作に影響させない
  }
}
