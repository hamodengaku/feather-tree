import type { CommandLogEntry } from '@feathertree/core';
import type { CommandLogEntryDto } from '@feathertree/ipc';

/**
 * コマンドログの 1 件を IPC の形へ写す。一覧の応答（commandLogRecent）と追記の通知（event:commandLogged）で共用する。
 * core ではまとまりの識別子を scope と呼ぶが、FeatherTree ではタブのセッション id なので sessionId として渡す。
 */
export function toCommandLogEntryDto(entry: CommandLogEntry): CommandLogEntryDto {
  return {
    seq: entry.seq,
    at: entry.at,
    cwd: entry.cwd,
    args: [...entry.args],
    exitCode: entry.exitCode,
    elapsedMs: entry.elapsedMs,
    ...(entry.stderr === undefined ? {} : { stderr: entry.stderr }),
    sessionId: entry.scope ?? null,
  };
}
