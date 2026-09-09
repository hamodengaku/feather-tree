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
