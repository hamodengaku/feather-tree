// git 操作層の公開 API。
// Electron を一切知らない純 Node のパッケージなので、CLI やテストから直接叩ける。
//
// ここに公開する操作は docs/02-git-command-map.md の対応表と 1:1 で対応する。
// 表に無い git 呼び出しを追加してはならない。

export * from './model/types.js';

export {
  GitCancelledError,
  GitCommandError,
  GitNotFoundError,
  GitParseError,
  GitTimeoutError,
} from './execution/errors.js';

export { DIFF_EXTRA, READ_PREFIX, WRITE_PREFIX } from './execution/gitEnvironment.js';
export { commandFor } from './execution/gitCommand.js';
export { runGitStream, runGitText, runGitWithProgress } from './execution/spawnGit.js';
export type { ChunkSink, GitCommand, GitExit } from './execution/spawnGit.js';
export { killTree } from './execution/killTree.js';
export { withMessageFile, withPathspecFile } from './execution/pathspecFile.js';

export { StatusParser, countEntries } from './parsing/statusPorcelainV2.js';
export { parseRefList } from './parsing/refList.js';
export { parseLog, parseNameStatus } from './parsing/log.js';
export { buildAddedFileDiff, looksBinary, parseUnifiedDiff } from './parsing/diff.js';
export type { DiffParseOptions } from './parsing/diff.js';
export { buildHunkPatch, canBuildPatch, hunkAllowsLineSelection, PatchBuildError } from './parsing/patch.js';
export type { BuiltPatch, HunkPick, PatchDirection, PatchRefusal } from './parsing/patch.js';

export type { GitContext } from './commands/context.js';
export { getGitVersion, listRemotes, resolveRepository } from './commands/repository.js';
export { getStatus } from './commands/status.js';
export type { StatusOptions } from './commands/status.js';
export { createBranch, listBranches, mergeBranch, switchBranch } from './commands/branches.js';
export { fetchRemote, pullCurrent, pushBranch } from './commands/remote.js';
export { buildCloneCommand, cloneRepository } from './commands/clone.js';
export type { CloneOptions } from './commands/clone.js';
export { getLfsVersion, lfsPull } from './commands/lfs.js';
export type { LfsVersion } from './commands/lfs.js';
export { FETCH_ALL_BRANCHES_REFSPEC, fetchUnshallow, setFetchAllBranches } from './commands/unshallow.js';
export { readUserIdentity, setLocalUserIdentity } from './commands/config.js';
export type { IdentityField, IdentityKey, IdentityScope, UserIdentity } from './commands/config.js';
export { getCommitFileDiff, getCommitFiles, getLog } from './commands/history.js';
export type { LogOptions } from './commands/history.js';
export { getFileDiff, getUntrackedFileDiff } from './commands/diff.js';
export type { DiffOptions } from './commands/diff.js';
export { applyHunks } from './commands/apply.js';
export type { ApplyHunksOptions } from './commands/apply.js';

export {
  commit,
  discardStagedAndWorktree,
  discardWorktree,
  removeUntracked,
  stagePaths,
  unstagePaths,
} from './commands/staging.js';
