// アプリ制御層の公開 API。
// electron を import しないため、CLI や別 UI からも同じロジックを使える。

export { locateGit } from './env/gitLocator.js';
export type { GitLocation, GitLocatorDeps, GitSource } from './env/gitLocator.js';
export { checkGitVersion, MIN_GIT_MAJOR, MIN_GIT_MINOR } from './env/gitVersion.js';
export type { GitVersionCheck } from './env/gitVersion.js';

// 土台の再輸出。アプリ側の import 元を 1 つに保つため。
export { CommandLog, RefreshCoordinator, SettingsStore } from '@feathertree/base-core';
export type { CommandLogEntry } from '@feathertree/base-core';

export { mapGitStderr } from './policy/errorMapping.js';
export type { FtErrorKind, MappedError } from './policy/errorMapping.js';
export {
  DESTRUCTIVE_ACTIONS,
  describeAction,
  requiresConfirmation,
} from './policy/destructiveActions.js';
export type { ConfirmationSpec, DestructiveAction } from './policy/destructiveActions.js';

export { DEFAULT_SETTINGS, normalizeSettings } from './settings/schema.js';
export { AppSettingsStore } from './settings/settingsStore.js';
export type { AppSettings, PaneWidths, ThemeName, UntrackedMode } from './settings/schema.js';

export { RepositorySession, toMappedError } from './session/repositorySession.js';
export type { SessionChange, SessionDeps } from './session/repositorySession.js';
export { SessionManager, displayNameOf } from './session/sessionManager.js';
export type { SessionInfo } from './session/sessionManager.js';
export {
  MAX_EXPLICIT_PATHS,
  filterEntries,
  pageEntries,
  resolveTarget,
} from './session/statusView.js';
export type {
  OperationTarget,
  StatusFilter,
  StatusGroup,
  StatusPage,
  StatusSummary,
} from './session/statusView.js';

export {
  NoSnapshotError,
  SessionOperations,
  StaleDiffError,
  TooManyPathsError,
} from './session/operations.js';
export type { HunkSelection } from './session/operations.js';
export type { OperationOutcome } from './session/operations.js';

// hunk / 行単位の可否判定（対応表 #33 / #34）。
// main はボタンの出し分けのためにこれを DTO へ写す。git 層の関数をそのまま通す。
export { canBuildPatch } from '@feathertree/git';
export type { PatchRefusal } from '@feathertree/git';
