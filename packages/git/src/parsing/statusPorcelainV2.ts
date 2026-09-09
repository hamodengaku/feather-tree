import { GitParseError } from '../execution/errors.js';
import type { ChunkSink } from '../execution/spawnGit.js';
import type { EntryKind, FileEntry, HeadInfo, StatusCode, StatusCounts, StatusSnapshot } from '../model/types.js';

const NUL = 0x00;
const CH_HASH = 0x23; // '#'
const CH_ONE = 0x31; // '1'
const CH_TWO = 0x32; // '2'
const CH_U = 0x75; // 'u'
const CH_QUESTION = 0x3f; // '?'
const CH_BANG = 0x21; // '!'

/** 種別ごとの「パスの前にある空白の数」。パス自体に空白が含まれうるので個数で切る。 */
const SPACES_BEFORE_PATH: Record<number, number> = {
  [CH_ONE]: 8,
  [CH_TWO]: 9,
  [CH_U]: 10,
  [CH_QUESTION]: 1,
  [CH_BANG]: 1,
};

/**
 * `git status --porcelain=v2 -z --branch` の出力を解釈する。
 *
 * 実装上の要点（docs/02-git-command-map.md パース時の注意）:
 *  - レコードは NUL 終端。ただし種別 `2`（リネーム／コピー）だけは
 *    「新パス NUL 元パス NUL」の 2 レコード分を消費する。
 *    NUL で単純分割すると必ず壊れる。
 *  - Buffer のまま走査し、必要な範囲だけ utf8 へ変換する。
 *  - チャンク境界をまたいだ未完バイトは次チャンクへ繰り越す。
 */
export class StatusParser implements ChunkSink<StatusSnapshot> {
  #carry: Buffer = Buffer.alloc(0);
  readonly #entries: FileEntry[] = [];
  #pendingRename: FileEntry | null = null;

  #oid: string | null = null;
  #branch: string | null = null;
  #detached = false;
  #upstream: string | null = null;
  #ahead = 0;
  #behind = 0;

  push(chunk: Buffer): void {
    const buf = this.#carry.length > 0 ? Buffer.concat([this.#carry, chunk]) : chunk;
    let start = 0;

    for (;;) {
      const nul = buf.indexOf(NUL, start);
      if (nul === -1) break;
      this.#handleRecord(buf, start, nul);
      start = nul + 1;
    }

    this.#carry = start >= buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(start));
  }

  finish(): StatusSnapshot {
    // NUL 終端されていない末尾レコードがあれば拾う（git は常に終端するが保険）
    if (this.#carry.length > 0) {
      this.#handleRecord(this.#carry, 0, this.#carry.length);
      this.#carry = Buffer.alloc(0);
    }
    if (this.#pendingRename !== null) {
      throw new GitParseError('リネームエントリの元パスが欠落しています');
    }

    const head: HeadInfo = {
      oid: this.#oid,
      branch: this.#branch,
      detached: this.#detached,
      upstream: this.#upstream,
      ahead: this.#ahead,
      behind: this.#behind,
    };

    return { head, entries: this.#entries, counts: countEntries(this.#entries) };
  }

  #handleRecord(buf: Buffer, start: number, end: number): void {
    if (end <= start) return;

    // 直前が種別 2 なら、このレコードは「元パス」
    if (this.#pendingRename !== null) {
      const origPath = buf.toString('utf8', start, end);
      this.#entries.push({ ...this.#pendingRename, origPath });
      this.#pendingRename = null;
      return;
    }

    const kindByte = buf[start];
    if (kindByte === undefined) return;

    if (kindByte === CH_HASH) {
      this.#handleHeader(buf.toString('utf8', start, end));
      return;
    }

    const spaces = SPACES_BEFORE_PATH[kindByte];
    if (spaces === undefined) {
      throw new GitParseError(`未知のエントリ種別: ${String.fromCharCode(kindByte)}`);
    }

    const record = buf.toString('utf8', start, end);
    const pathOffset = offsetAfterNthSpace(record, spaces);
    if (pathOffset === -1) throw new GitParseError(`エントリの形式が不正です: ${record.slice(0, 40)}`);
    const path = record.slice(pathOffset);

    if (kindByte === CH_QUESTION || kindByte === CH_BANG) {
      const kind: EntryKind = kindByte === CH_QUESTION ? 'untracked' : 'ignored';
      const code: StatusCode = kindByte === CH_QUESTION ? '?' : '!';
      this.#entries.push({ kind, path, staged: '.', worktree: code });
      return;
    }

    const xy = record.slice(2, 4);
    const staged = toStatusCode(xy[0]);
    const worktree = toStatusCode(xy[1]);

    if (kindByte === CH_ONE) {
      this.#entries.push({ kind: 'ordinary', path, staged, worktree });
      return;
    }

    if (kindByte === CH_U) {
      this.#entries.push({ kind: 'unmerged', path, staged, worktree });
      return;
    }

    // 種別 2: スコアを取り出し、元パスは次レコードで補完する
    const scoreToken = tokenBeforePath(record, spaces);
    const score = Number.parseInt(scoreToken.slice(1), 10);
    this.#pendingRename = {
      kind: 'renamed',
      path,
      staged,
      worktree,
      ...(Number.isFinite(score) ? { score } : {}),
    };
  }

  #handleHeader(line: string): void {
    if (line.startsWith('# branch.oid ')) {
      const value = line.slice('# branch.oid '.length);
      this.#oid = value === '(initial)' ? null : value;
      return;
    }
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length);
      if (value === '(detached)') {
        this.#detached = true;
        this.#branch = null;
      } else {
        this.#branch = value;
      }
      return;
    }
    if (line.startsWith('# branch.upstream ')) {
      this.#upstream = line.slice('# branch.upstream '.length);
      return;
    }
    if (line.startsWith('# branch.ab ')) {
      const value = line.slice('# branch.ab '.length);
      const match = /^\+([0-9]+) -([0-9]+)$/.exec(value);
      if (match !== null) {
        this.#ahead = Number.parseInt(match[1] ?? '0', 10);
        this.#behind = Number.parseInt(match[2] ?? '0', 10);
      }
    }
  }
}

/** n 個目の空白の直後のインデックスを返す。見つからなければ -1。 */
function offsetAfterNthSpace(s: string, n: number): number {
  let found = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) === 0x20) {
      found += 1;
      if (found === n) return i + 1;
    }
  }
  return -1;
}

/** パスの直前のトークン（種別 2 のスコア `R100` 等）を返す。 */
function tokenBeforePath(s: string, spacesBeforePath: number): string {
  const startOfToken = offsetAfterNthSpace(s, spacesBeforePath - 1);
  const endOfToken = offsetAfterNthSpace(s, spacesBeforePath) - 1;
  if (startOfToken === -1 || endOfToken < startOfToken) return '';
  return s.slice(startOfToken, endOfToken);
}

const VALID_CODES = new Set(['.', 'M', 'T', 'A', 'D', 'R', 'C', 'U', '?', '!']);

function toStatusCode(ch: string | undefined): StatusCode {
  if (ch !== undefined && VALID_CODES.has(ch)) return ch as StatusCode;
  return '.';
}

export function countEntries(entries: readonly FileEntry[]): StatusCounts {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let unmerged = 0;

  for (const e of entries) {
    if (e.kind === 'untracked') {
      untracked += 1;
    } else if (e.kind === 'unmerged') {
      unmerged += 1;
    } else if (e.kind === 'ordinary' || e.kind === 'renamed') {
      if (e.staged !== '.') staged += 1;
      if (e.worktree !== '.') unstaged += 1;
    }
  }

  return { staged, unstaged, untracked, unmerged, total: entries.length };
}
