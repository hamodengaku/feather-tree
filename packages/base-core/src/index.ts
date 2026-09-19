// 土台: 純 Node のユーティリティ。
//
// electron も UI も知らないので、CLI やテストからそのまま使える。
// アプリ固有の知識（このプロジェクトなら git）を一切持ち込まないこと。
export { CommandLog } from './diagnostics/commandLog.js';
export type { CommandLogEntry } from './diagnostics/commandLog.js';
export { RefreshCoordinator } from './concurrency/refreshCoordinator.js';
export { PathOutsideRootError, assertInsideRoot, assertRealPathInsideRoot } from './fs/pathGuard.js';
export { SettingsStore } from './settings/settingsStore.js';
export {
  boolOr,
  clampFloatOrNull,
  clampInt,
  intOrNull,
  pickFrom,
  record,
  stringArray,
  stringArrayRecord,
  stringOrNull,
} from './settings/normalize.js';
