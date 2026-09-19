import { toMappedError } from '@feathertree/core';
import { HandlerError, createResultWrapper } from '@feathertree/base-electron';
import type { FtErrorDto } from '@feathertree/ipc';

/**
 * FeatherTree のエラー写像。
 *
 * 土台の `createResultWrapper` に注入する形にしてあるので、
 * 「IPC 越しに例外を投げない」という仕組み自体は土台側にある。
 */
function toDto(err: unknown): FtErrorDto {
  // core 由来のエラーは名前で判別する（core は ipc の型を知らないため）
  if (err instanceof Error && err.name === 'TooManyPathsError') {
    return { kind: 'too-many-paths', message: err.message };
  }
  if (err instanceof Error && err.name === 'StaleDiffError') {
    return { kind: 'diff-stale', message: err.message };
  }
  if (err instanceof Error && err.name === 'PatchBuildError') {
    return { kind: 'internal', message: err.message };
  }
  if (err instanceof Error && err.name === 'NoSnapshotError') {
    return { kind: 'internal', message: err.message };
  }
  if (err instanceof Error && err.name === 'ConflictUnsupportedError') {
    return { kind: 'internal', message: err.message };
  }
  if (err instanceof Error && err.name === 'PathOutsideRootError') {
    return { kind: 'invalid-path', message: err.message };
  }

  const mapped = toMappedError(err);
  return {
    kind: mapped.kind,
    message: mapped.message,
    ...(mapped.detail === undefined ? {} : { detail: mapped.detail }),
    ...(mapped.exitCode === undefined ? {} : { exitCode: mapped.exitCode }),
  };
}

export const wrap = createResultWrapper<FtErrorDto>(toDto);
export { HandlerError };
