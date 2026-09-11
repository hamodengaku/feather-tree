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
  type HunkStageRequest,
  type CommitRequest,
  type FeatherTreeBridge,
  type FocusRefreshPromptEvent,
  type OperationTargetDto,
  type ProgressEvent,
  type RefreshScope,
  type SessionChangedEvent,
  type SettingsDto,
  type StatusPageRequest,
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

  sessionPickAndOpen: () => ipcRenderer.invoke(CHANNELS.sessionPickAndOpen),
  sessionOpen: (root: string) => ipcRenderer.invoke(CHANNELS.sessionOpen, root),
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
  logGetPage: (id: string, skip: number) => ipcRenderer.invoke(CHANNELS.logGetPage, id, skip),
  branchList: (id: string) => ipcRenderer.invoke(CHANNELS.branchList, id),
  branchSwitch: (id: string, branchName: string) =>
    ipcRenderer.invoke(CHANNELS.branchSwitch, id, branchName),
  branchCreate: (id: string, req: BranchCreateRequest) => ipcRenderer.invoke(CHANNELS.branchCreate, id, req),
  branchMerge: (id: string, branchName: string, confirmed?: boolean) =>
    ipcRenderer.invoke(CHANNELS.branchMerge, id, branchName, confirmed),
  shellOpenPath: (id: string, path: string) => ipcRenderer.invoke(CHANNELS.shellOpenPath, id, path),
  shellShowInFolder: (id: string, path: string) =>
    ipcRenderer.invoke(CHANNELS.shellShowInFolder, id, path),

  commandLogRecent: (limit: number) => ipcRenderer.invoke(CHANNELS.commandLogRecent, limit),

  onSessionChanged: (listener: (event: SessionChangedEvent) => void) =>
    subscribe(CHANNELS.eventSessionChanged, listener),
  onProgress: (listener: (event: ProgressEvent) => void) =>
    subscribe(CHANNELS.eventProgress, listener),
  onFocusRefreshPrompt: (listener: (event: FocusRefreshPromptEvent) => void) =>
    subscribe(CHANNELS.eventFocusRefreshPrompt, listener),
};

contextBridge.exposeInMainWorld('ft', bridge);
