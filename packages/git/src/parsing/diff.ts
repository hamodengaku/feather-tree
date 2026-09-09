import type { DiffHunk, DiffLine, FileDiff } from '../model/types.js';

export interface DiffParseOptions {
  /** 1 ファイルあたりの最大行数。超えたら打ち切って truncated を立てる。 */
  readonly maxLines?: number;
}

const DEFAULT_MAX_LINES = 20000;
const HUNK_HEADER = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/;

/**
 * `git diff --no-color --no-ext-diff` の unified diff を解釈する。
 *
 * 描画から独立させてあるため、side-by-side 表示を後付けするときも
 * このパーサはそのまま使える（docs/00-decisions.md 決定 19）。
 */
export function parseUnifiedDiff(stdout: string, options: DiffParseOptions = {}): FileDiff[] {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const lines = stdout.split('\n');
  const files: FileDiff[] = [];

  let current: MutableFileDiff | null = null;
  let hunk: MutableHunk | null = null;
  let emitted = 0;

  const closeHunk = (): void => {
    if (current !== null && hunk !== null) {
      current.hunks.push({
        header: hunk.header,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines: hunk.lines,
      });
    }
    hunk = null;
  };

  const closeFile = (): void => {
    closeHunk();
    if (current !== null) {
      files.push({
        path: current.path,
        oldPath: current.oldPath,
        binary: current.binary,
        hunks: current.hunks,
        truncated: current.truncated,
      });
    }
    current = null;
  };

  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      closeFile();
      current = {
        path: extractNewPath(raw),
        oldPath: null,
        binary: false,
        hunks: [],
        truncated: false,
      };
      emitted = 0;
      continue;
    }

    if (current === null) continue;

    if (raw.startsWith('--- ')) {
      const p = stripPrefix(raw.slice(4));
      if (p !== null) current.oldPath = p;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = stripPrefix(raw.slice(4));
      if (p !== null) current.path = p;
      continue;
    }
    if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
      current.binary = true;
      continue;
    }
    if (raw.startsWith('rename from ')) {
      current.oldPath = raw.slice('rename from '.length);
      continue;
    }
    if (raw.startsWith('rename to ')) {
      current.path = raw.slice('rename to '.length);
      continue;
    }

    const header = HUNK_HEADER.exec(raw);
    if (header !== null) {
      closeHunk();
      const oldStart = Number.parseInt(header[1] ?? '0', 10);
      const newStart = Number.parseInt(header[3] ?? '0', 10);
      hunk = {
        header: raw,
        oldStart,
        oldLines: header[2] === undefined ? 1 : Number.parseInt(header[2], 10),
        newStart,
        newLines: header[4] === undefined ? 1 : Number.parseInt(header[4], 10),
        lines: [],
        oldNo: oldStart,
        newNo: newStart,
      };
      continue;
    }

    if (hunk === null) continue;

    if (emitted >= maxLines) {
      current.truncated = true;
      continue;
    }

    const marker = raw.charAt(0);
    if (marker === '+') {
      hunk.lines.push({ kind: 'added', text: raw.slice(1), oldLineNo: null, newLineNo: hunk.newNo });
      hunk.newNo += 1;
      emitted += 1;
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'removed', text: raw.slice(1), oldLineNo: hunk.oldNo, newLineNo: null });
      hunk.oldNo += 1;
      emitted += 1;
    } else if (marker === ' ') {
      hunk.lines.push({ kind: 'context', text: raw.slice(1), oldLineNo: hunk.oldNo, newLineNo: hunk.newNo });
      hunk.oldNo += 1;
      hunk.newNo += 1;
      emitted += 1;
    } else if (raw.charCodeAt(0) === 92) {
      // 「\ No newline at end of file」
      hunk.lines.push({ kind: 'no-newline', text: raw.slice(2), oldLineNo: null, newLineNo: null });
    }
  }

  closeFile();
  return files;
}

/** 未追跡ファイルの内容を「全行追加」の diff として表現する。git は呼ばない。 */
export function buildAddedFileDiff(path: string, content: string, options: DiffParseOptions = {}): FileDiff {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const all = content.split('\n');
  // 末尾の空要素（最終改行由来）は行として数えない
  if (all.length > 0 && all[all.length - 1] === '') all.pop();

  const kept = all.slice(0, maxLines);
  const lines: DiffLine[] = kept.map((text, i) => ({
    kind: 'added',
    text,
    oldLineNo: null,
    newLineNo: i + 1,
  }));

  const hunk: DiffHunk = {
    header: `@@ -0,0 +1,${kept.length} @@`,
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: kept.length,
    lines,
  };

  return {
    path,
    oldPath: null,
    binary: false,
    hunks: kept.length > 0 ? [hunk] : [],
    truncated: all.length > kept.length,
  };
}

/** 先頭 8KB に NUL バイトがあればバイナリと判定する。 */
export function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8 * 1024);
  return head.includes(0x00);
}

interface MutableFileDiff {
  path: string;
  oldPath: string | null;
  binary: boolean;
  hunks: DiffHunk[];
  truncated: boolean;
}

interface MutableHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  oldNo: number;
  newNo: number;
}

function extractNewPath(diffGitLine: string): string {
  // diff --git a/<old> b/<new> ... パスに空白があると曖昧なので +++ 行で上書きされる前提の暫定値
  const idx = diffGitLine.lastIndexOf(' b/');
  if (idx === -1) return diffGitLine.slice('diff --git '.length);
  return diffGitLine.slice(idx + 3);
}

function stripPrefix(pathToken: string): string | null {
  // パスに空白が含まれる場合、git は `+++ b/a b.txt<TAB>` のようにタブ区切りを付ける。
  // ここを取りこぼすとパス末尾にタブが残る。
  const tab = pathToken.indexOf(String.fromCharCode(9));
  const token = tab === -1 ? pathToken : pathToken.slice(0, tab);
  if (token === '/dev/null') return null;
  if (token.startsWith('a/') || token.startsWith('b/')) return token.slice(2);
  return token;
}
