/**
 * 境界。ロジックを書かない。
 *
 * チャネル名を renderer に露出させず、ホワイトリストした関数だけを公開する。
 * sandbox: true で動くため、ここで使えるのは electron の contextBridge / ipcRenderer だけ
 * （docs/01-architecture.md 2 章）。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  CHANNELS,
  type BranchCreateRequest,
  type CloneProgressEvent,
  type CloneRequest,
  type CommandEndEvent,
  type CommandLogEntryDto,
  type CommandStartEvent,
  type ConflictResolveRequest,
  type HunkStageRequest,
  type CommitRequest,
  type FeatherTreeBridge,
  type FocusRefreshPromptEvent,
  type GitIdentityRequest,
  type OperationTargetDto,
  type PickFileKindDto,
  type ProgressEvent,
  type PushRequest,
  type RefreshScope,
  type SessionChangedEvent,
  type SettingsDto,
  type StashApplyRequest,
  type StashRefDto,
  type StatusPageRequest,
  type UpdateAvailableEvent,
} from '@feathertree/ipc';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const bridge: FeatherTreeBridge = {
  appGetInfo: () => ipcRenderer.invoke(CHANNELS.appGetInfo),
  appGetEnvironment: () => ipcRenderer.invoke(CHANNELS.appGetEnvironment),

  settingsGet: () => ipcRenderer.invoke(CHANNELS.settingsGet),
  settingsUpdate: (patch: Partial<SettingsDto>) => ipcRenderer.invoke(CHANNELS.settingsUpdate, patch),
  dialogPickFile: (kind: PickFileKindDto) => ipcRenderer.invoke(CHANNELS.dialogPickFile, kind),
  gitConfigGetIdentity: (id: string) => ipcRenderer.invoke(CHANNELS.gitConfigGetIdentity, id),
  gitConfigSetIdentity: (id: string, req: GitIdentityRequest) =>
    ipcRenderer.invoke(CHANNELS.gitConfigSetIdentity, id, req),
  sshSetKey: (id: string, keyPath: string | null) =>
    ipcRenderer.invoke(CHANNELS.sshSetKey, id, keyPath),

  sessionPickAndCreate: () => ipcRenderer.invoke(CHANNELS.sessionPickAndCreate),
  sessionLoad: (id: string) => ipcRenderer.invoke(CHANNELS.sessionLoad, id),
  sessionOpen: (root: string) => ipcRenderer.invoke(CHANNELS.sessionOpen, root),
  clonePickDirectory: () => ipcRenderer.invoke(CHANNELS.clonePickDirectory),
  sessionCloneAndCreate: (req: CloneRequest) => ipcRenderer.invoke(CHANNELS.sessionCloneAndCreate, req),
  cloneCancel: () => ipcRenderer.invoke(CHANNELS.cloneCancel),
  sessionList: () => ipcRenderer.invoke(CHANNELS.sessionList),
  sessionActivate: (id: string) => ipcRenderer.invoke(CHANNELS.sessionActivate, id),
  sessionClose: (id: string) => ipcRenderer.invoke(CHANNELS.sessionClose, id),
  sessionRefresh: (id: string, scope: RefreshScope) =>
    ipcRenderer.invoke(CHANNELS.sessionRefresh, id, scope),
  sessionReorder: (order: readonly string[]) => ipcRenderer.invoke(CHANNELS.sessionReorder, order),

  statusGetSummary: (id: string) => ipcRenderer.invoke(CHANNELS.statusGetSummary, id),
  statusGetPage: (id: string, req: StatusPageRequest) =>
    ipcRenderer.invoke(CHANNELS.statusGetPage, id, req),

  stage: (id: string, target: OperationTargetDto) => ipcRenderer.invoke(CHANNELS.stage, id, target),
  unstage: (id: string, target: OperationTargetDto) => ipcRenderer.invoke(CHANNELS.unstage, id, target),
  stageHunks: (id: string, req: HunkStageRequest) => ipcRenderer.invoke(CHANNELS.stageHunks, id, req),
  unstageHunks: (id: string, req: HunkStageRequest) =>
    ipcRenderer.invoke(CHANNELS.unstageHunks, id, req),
  discard: (id: string, target: OperationTargetDto, confirmed?: boolean) =>
    ipcRenderer.invoke(CHANNELS.discard, id, target, confirmed),
  deleteUntracked: (id: string, target: OperationTargetDto, confirmed?: boolean) =>
    ipcRenderer.invoke(CHANNELS.deleteUntracked, id, target, confirmed),
  commit: (id: string, req: CommitRequest, confirmed?: boolean) =>
    ipcRenderer.invoke(CHANNELS.commit, id, req, confirmed),

  diffGet: (id: string, path: string, staged: boolean) =>
    ipcRenderer.invoke(CHANNELS.diffGet, id, path, staged),
  conflictGet: (id: string, path: string) => ipcRenderer.invoke(CHANNELS.conflictGet, id, path),
  conflictResolve: (id: string, req: ConflictResolveRequest) =>
    ipcRenderer.invoke(CHANNELS.conflictResolve, id, req),
  logGetPage: (id: string, skip: number) => ipcRenderer.invoke(CHANNELS.logGetPage, id, skip),
  commitGetFiles: (id: string, oid: string) => ipcRenderer.invoke(CHANNELS.commitGetFiles, id, oid),
  commitGetDiff: (id: string, oid: string, path: string) =>
    ipcRenderer.invoke(CHANNELS.commitGetDiff, id, oid, path),
  branchList: (id: string) => ipcRenderer.invoke(CHANNELS.branchList, id),
  branchSwitch: (id: string, branchName: string) =>
    ipcRenderer.invoke(CHANNELS.branchSwitch, id, branchName),
  branchCreate: (id: string, req: BranchCreateRequest) => ipcRenderer.invoke(CHANNELS.branchCreate, id, req),
  branchMerge: (id: string, branchName: string, confirmed?: boolean) =>
    ipcRenderer.invoke(CHANNELS.branchMerge, id, branchName, confirmed),
  stashList: (id: string) => ipcRenderer.invoke(CHANNELS.stashList, id),
  stashSave: (id: string, message: string) => ipcRenderer.invoke(CHANNELS.stashSave, id, message),
  stashApply: (id: string, req: StashApplyRequest) => ipcRenderer.invoke(CHANNELS.stashApply, id, req),
  stashDrop: (id: string, stash: StashRefDto, confirmed?: boolean) =>
    ipcRenderer.invoke(CHANNELS.stashDrop, id, stash, confirmed),
  stashGetFiles: (id: string, stash: StashRefDto) =>
    ipcRenderer.invoke(CHANNELS.stashGetFiles, id, stash),
  stashGetDiff: (id: string, stash: StashRefDto, path: string) =>
    ipcRenderer.invoke(CHANNELS.stashGetDiff, id, stash, path),

  remoteList: (id: string) => ipcRenderer.invoke(CHANNELS.remoteList, id),
  remoteFetch: (id: string, remote: string) => ipcRenderer.invoke(CHANNELS.remoteFetch, id, remote),
  remotePull: (id: string) => ipcRenderer.invoke(CHANNELS.remotePull, id),
  remotePush: (id: string, req: PushRequest) => ipcRenderer.invoke(CHANNELS.remotePush, id, req),

  shellOpenPath: (id: string, path: string, confirmed?: boolean) =>
    ipcRenderer.invoke(CHANNELS.shellOpenPath, id, path, confirmed),
  shellShowInFolder: (id: string, path: string) =>
    ipcRenderer.invoke(CHANNELS.shellShowInFolder, id, path),
  shellOpenTerminal: (id: string) => ipcRenderer.invoke(CHANNELS.shellOpenTerminal, id),

  commandLogRecent: (limit: number) => ipcRenderer.invoke(CHANNELS.commandLogRecent, limit),

  updateGetState: () => ipcRenderer.invoke(CHANNELS.updateGetState),
  updateCheckNow: () => ipcRenderer.invoke(CHANNELS.updateCheckNow),
  updateOpenReleasePage: () => ipcRenderer.invoke(CHANNELS.updateOpenReleasePage),
  updateDismiss: () => ipcRenderer.invoke(CHANNELS.updateDismiss),

  onSessionChanged: (listener: (event: SessionChangedEvent) => void) =>
    subscribe(CHANNELS.eventSessionChanged, listener),
  onProgress: (listener: (event: ProgressEvent) => void) =>
    subscribe(CHANNELS.eventProgress, listener),
  onCloneProgress: (listener: (event: CloneProgressEvent) => void) =>
    subscribe(CHANNELS.eventCloneProgress, listener),
  onFocusRefreshPrompt: (listener: (event: FocusRefreshPromptEvent) => void) =>
    subscribe(CHANNELS.eventFocusRefreshPrompt, listener),
  onCommandStart: (listener: (event: CommandStartEvent) => void) =>
    subscribe(CHANNELS.eventCommandStart, listener),
  onCommandEnd: (listener: (event: CommandEndEvent) => void) =>
    subscribe(CHANNELS.eventCommandEnd, listener),
  onCommandLogged: (listener: (entry: CommandLogEntryDto) => void) =>
    subscribe(CHANNELS.eventCommandLogged, listener),
  onUpdateAvailable: (listener: (event: UpdateAvailableEvent) => void) =>
    subscribe(CHANNELS.eventUpdateAvailable, listener),
};

contextBridge.exposeInMainWorld('ft', bridge);
