// アプリ制御層の公開 API。
// electron を import しないため、CLI や別 UI からも同じロジックを使える。

export { locateGit } from './env/gitLocator.js';
export type { GitLocation, GitLocatorDeps, GitSource } from './env/gitLocator.js';
export { locateTerminal } from './env/terminalLocator.js';
export type { TerminalLaunch, TerminalLocatorDeps } from './env/terminalLocator.js';
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
export { OPEN_EXECUTABLE_CONFIRMATION, isExecutableFileName } from './policy/executableFile.js';

export { DEFAULT_SETTINGS, normalizeSettings } from './settings/schema.js';
export { AppSettingsStore } from './settings/settingsStore.js';
export type { AppSettings, PaneWidths, ThemeName, UntrackedMode } from './settings/schema.js';

export { RepositorySession, toMappedError } from './session/repositorySession.js';
export type { CommandStart, SessionChange, SessionDeps } from './session/repositorySession.js';
export { SessionManager, displayNameOf } from './session/sessionManager.js';
export type { CloneOutcome, CloneTarget, SessionInfo } from './session/sessionManager.js';

// クローン（決定 9 / 対応表 #37〜#41）
export { CloneProgressTracker, parseProgressLine, planStages } from './clone/cloneProgress.js';
export type {
  CloneMode,
  CloneStage,
  CloneStageGroup,
  CloneStageState,
  CloneStep,
  FeedResult,
  ParsedProgress,
  StepOutcome,
} from './clone/cloneProgress.js';
export { cleanStderr, runClone } from './clone/cloneRunner.js';
export type {
  CloneProgressListener,
  CloneResultKind,
  CloneRunDeps,
  CloneRunRequest,
  CloneRunResult,
} from './clone/cloneRunner.js';
export {
  MAX_HINTS,
  cancelledHint,
  cloneHints,
  gitNotFoundHint,
  lfsMissingHint,
  sshEndpoint,
} from './policy/cloneHints.js';
export { redactUrl } from './policy/redactUrl.js';
export type { CloneHint, CloneHintContext, SshEndpoint } from './policy/cloneHints.js';
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

// アプリ終了時の後始末（docs/01-architecture.md 11 章）。
// main は @feathertree/git に依存していないので、core が素通しする。
export { killAllGitProcesses, runningGitCount } from '@feathertree/git';

// 更新通知（決定 29）。electron を知らない純関数だけをここに置く。
export { compareVersions, isNewer, parseReleaseTag } from './update/version.js';
export type { Version } from './update/version.js';
export { UPDATE_CHECK_INTERVAL_MS, evaluateLatestRelease, shouldCheck } from './update/updateCheckPolicy.js';
export type { LatestRelease } from './update/updateCheckPolicy.js';
