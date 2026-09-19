import type {
  ConflictBlock,
  ConflictChoice,
  ConflictFile,
  ConflictLine,
  ConflictSection,
} from '../model/types.js';

/**
 * コンフリクトマーカーの解釈と、1 ブロック分の採用（対応表の対象外 — git を起動しない）。
 *
 * ここは I/O も描画も知らない純関数。`commands/conflict.ts` がファイルの読み書きを担い、
 * この層は**文字列と行の構造**だけを扱う。
 *
 * マーカーの長さは **7 文字固定**とする。git の `conflict-marker-size`（gitattributes）で
 * 長さを変えているリポジトリでは 1 件も見つからず、画面は「マーカーが見つからない」に倒れる
 * （＝外部ツールで解決してもらう）。誤って 8 文字以上の `<<<<<<<<` を含む本文を
 * マーカーと読み違えるより、見つけられないほうが安全なのでこちらを採る。
 */

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

/*
 * マーカー行の判定。ラベル部は「空白 + 任意の文字列」。
 * `( .*)?$` の形にしてあるので 8 文字目が同じ記号なら一致しない（長さ 7 の固定）。
 * `|||||||` は文字クラスで書く（エスケープを重ねると読めなくなるため）。
 */
const OURS_MARKER = /^<<<<<<<( .*)?$/;
const BASE_MARKER = /^[|]{7}( .*)?$/;
const SEPARATOR_MARKER = /^={7}$/;
const THEIRS_MARKER = /^>>>>>>>( .*)?$/;

/** 行 1 本。終端記号を**行ごとに**持つので、CRLF と LF が混ざったファイルでも復元できる。 */
export interface TextLine {
  /** 終端記号を除いた本文。 */
  readonly text: string;
  /** その行の終端記号。ファイル末尾に改行が無い行だけ空文字。 */
  readonly terminator: string;
}

export interface ConflictParse {
  readonly lines: readonly TextLine[];
  readonly blocks: readonly ConflictBlock[];
  /**
   * マーカーが壊れている（閉じていない・入れ子）。
   *
   * 採用ボタンを出さない印。中途半端に解決すると本文を壊すので、
   * このファイルは丸ごと外部ツールに委ねる。
   */
  readonly malformed: boolean;
}

export interface ConflictViewOptions {
  /** 衝突の前後に付ける文脈行の数。既定は 3（diff の既定と同じ）。 */
  readonly contextLines?: number;
  /** 画面に出す行数の上限。超えた分は切り、truncated を立てる。 */
  readonly maxLines?: number;
}

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_LINES = 20000;

/**
 * 終端記号を保ったまま行に分ける。
 *
 * `split(NL)` を使わないのは、CRLF と「末尾に改行が無い」を区別できないため。
 * 採用の結果はこの配列をつなぎ直して書くので、ここで落とした情報はそのまま
 * ファイルの書き換え事故（改行コードの置換）になる。
 */
export function splitLines(content: string): TextLine[] {
  const out: TextLine[] = [];
  let start = 0;
  for (;;) {
    const nl = content.indexOf(NL, start);
    if (nl === -1) {
      // 末尾に改行が無い場合の残り。空文字なら行として数えない
      if (start < content.length) out.push({ text: content.slice(start), terminator: '' });
      return out;
    }
    const hasCr = nl > start && content.charCodeAt(nl - 1) === 13;
    out.push({
      text: content.slice(start, hasCr ? nl - 1 : nl),
      terminator: hasCr ? CR + NL : NL,
    });
    start = nl + 1;
  }
}

export function joinLines(lines: readonly TextLine[]): string {
  let out = '';
  for (const line of lines) out += line.text + line.terminator;
  return out;
}

/** マーカーのラベル（`<<<<<<< HEAD` の `HEAD`）。ラベルが無ければ空文字。 */
function labelOf(match: RegExpExecArray): string {
  const captured = match[1];
  return captured === undefined ? '' : captured.slice(1);
}

/**
 * コンフリクトマーカーを探す。
 *
 * 走査は **`<<<<<<<` を見つけたときだけ**状態機械に入る。ブロックの外にある
 * `=======` や `>>>>>>>` は本文として扱う（Markdown の見出し下線が `=======` になるため、
 * これを壊れた印にすると普通のファイルが解決不能になる）。
 * ブロックの中で次の `<<<<<<<` に出会う／閉じないまま終端に着いたら malformed。
 */
export function parseConflictMarkers(content: string): ConflictParse {
  const lines = splitLines(content);
  const blocks: ConflictBlock[] = [];
  let malformed = false;

  let i = 0;
  while (i < lines.length) {
    const text = lines[i]?.text ?? '';
    const start = OURS_MARKER.exec(text);
    if (start === null) {
      i += 1;
      continue;
    }

    const startLine = i + 1;
    const ourLabel = labelOf(start);
    let baseLine: number | null = null;
    let baseLabel: string | null = null;
    let separatorLine: number | null = null;
    let endLine: number | null = null;
    let theirLabel = '';

    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const body = lines[j]?.text ?? '';

      if (OURS_MARKER.test(body)) {
        // 入れ子。どちらの側の本文か決められないので、このファイルは触らない
        malformed = true;
        break;
      }

      if (separatorLine === null && baseLine === null) {
        const base = BASE_MARKER.exec(body);
        if (base !== null) {
          baseLine = j + 1;
          baseLabel = labelOf(base);
          continue;
        }
      }

      if (separatorLine === null) {
        if (SEPARATOR_MARKER.test(body)) separatorLine = j + 1;
        continue;
      }

      const end = THEIRS_MARKER.exec(body);
      if (end !== null) {
        endLine = j + 1;
        theirLabel = labelOf(end);
        break;
      }
    }

    if (malformed) break;

    if (separatorLine === null || endLine === null) {
      // 閉じていないマーカー。ここから先は構造が読めない
      malformed = true;
      break;
    }

    const ourEnd = baseLine ?? separatorLine;
    blocks.push({
      index: blocks.length,
      startLine,
      baseLine,
      separatorLine,
      endLine,
      ourLabel,
      baseLabel,
      theirLabel,
      ourCount: ourEnd - startLine - 1,
      baseCount: baseLine === null ? 0 : separatorLine - baseLine - 1,
      theirCount: endLine - separatorLine - 1,
    });

    i = endLine;
  }

  /*
   * malformed でも、そこまでに読めたブロックは返す。
   * 画面に「何も無い」と出すより、読めたところまで見せて**採用ボタンだけを消す**ほうが、
   * 外部ツールへ持っていく判断の材料になる（採否の判断は呼び出し側が malformed で行う）。
   */
  return { lines, blocks, malformed };
}

/** ブロックの各側が占める範囲（0 始まり・終端は含まない）。 */
export function blockRanges(block: ConflictBlock): {
  readonly ours: readonly [number, number];
  readonly base: readonly [number, number] | null;
  readonly theirs: readonly [number, number];
} {
  const ourEnd = (block.baseLine ?? block.separatorLine) - 1;
  return {
    ours: [block.startLine, ourEnd],
    base: block.baseLine === null ? null : [block.baseLine, block.separatorLine - 1],
    theirs: [block.separatorLine, block.endLine - 1],
  };
}

/**
 * 1 ブロックだけを採用して、ファイル全体の行を作り直す。
 *
 * マーカー行（`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`）と、採用しなかった側、
 * および共通祖先（diff3 スタイル）は落ちる。**他のブロックには一切触れない。**
 */
export function resolveConflictBlock(
  lines: readonly TextLine[],
  block: ConflictBlock,
  choice: ConflictChoice,
): TextLine[] {
  const ranges = blockRanges(block);
  const ours = lines.slice(ranges.ours[0], ranges.ours[1]);
  const theirs = lines.slice(ranges.theirs[0], ranges.theirs[1]);

  const picked =
    choice === 'ours'
      ? ours
      : choice === 'theirs'
        ? theirs
        : choice === 'ours-theirs'
          ? [...ours, ...theirs]
          : [...theirs, ...ours];

  const next = [...lines.slice(0, block.startLine - 1), ...picked, ...lines.slice(block.endLine)];

  /*
   * 元のファイルが改行で終わっていなければ、その性質を保つ。
   *
   * 末尾に改行が無いのは `>>>>>>>` の行（＝これから消す行）なので、素直につなぐと
   * **採用した最後の行の改行が残り、ファイルに改行が 1 つ増える**。git の diff に
   * 「\ No newline at end of file」の出入りとして現れてしまうので、ここで落とす。
   */
  const lastOriginal = lines[lines.length - 1];
  if (block.endLine === lines.length && lastOriginal?.terminator === '') {
    const last = next[next.length - 1];
    if (last !== undefined) next[next.length - 1] = { text: last.text, terminator: '' };
  }

  return next;
}

/**
 * 画面に出す形へ組み替える。
 *
 * ファイル全体は出さない。**衝突のまわりだけ**を diff の hunk と同じ見え方で並べる
 * （利用者が読みたいのはマーカーの中身であり、無関係な数千行ではない）。
 * 文脈行が隣のブロックと重ならないよう、前のブロックが使い切った位置から切り出す。
 */
export function buildConflictFile(
  path: string,
  parse: ConflictParse,
  options: ConflictViewOptions = {},
): ConflictFile {
  const contextLines = Math.max(0, options.contextLines ?? DEFAULT_CONTEXT_LINES);
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES);

  const sections: ConflictSection[] = [];
  let budget = maxLines;
  let fileTruncated = false;
  /** ここまでの行は既にどこかの節で出した（0 始まり）。 */
  let consumed = 0;

  parse.blocks.forEach((block, position) => {
    const ranges = blockRanges(block);
    const startIndex = block.startLine - 1;
    const endIndex = block.endLine - 1;
    const nextStart = parse.blocks[position + 1]?.startLine;

    const beforeFrom = Math.max(consumed, startIndex - contextLines);
    const afterTo = Math.min(
      nextStart === undefined ? parse.lines.length : nextStart - 1,
      endIndex + 1 + contextLines,
    );

    const lines: ConflictLine[] = [];
    let sectionTruncated = false;

    const push = (index: number, kind: ConflictLine['kind']): void => {
      if (budget <= 0) {
        sectionTruncated = true;
        fileTruncated = true;
        return;
      }
      lines.push({ kind, text: parse.lines[index]?.text ?? '', lineNo: index + 1 });
      budget -= 1;
    };

    for (let k = beforeFrom; k < startIndex; k += 1) push(k, 'context');
    push(startIndex, 'marker');
    for (let k = ranges.ours[0]; k < ranges.ours[1]; k += 1) push(k, 'ours');
    if (block.baseLine !== null && ranges.base !== null) {
      push(block.baseLine - 1, 'marker');
      for (let k = ranges.base[0]; k < ranges.base[1]; k += 1) push(k, 'base');
    }
    push(block.separatorLine - 1, 'marker');
    for (let k = ranges.theirs[0]; k < ranges.theirs[1]; k += 1) push(k, 'theirs');
    push(endIndex, 'marker');
    for (let k = endIndex + 1; k < afterTo; k += 1) push(k, 'context');

    consumed = afterTo;
    sections.push({
      index: block.index,
      startLine: block.startLine,
      endLine: block.endLine,
      ourLabel: block.ourLabel,
      theirLabel: block.theirLabel,
      baseLabel: block.baseLabel,
      ourCount: block.ourCount,
      theirCount: block.theirCount,
      lines,
      truncated: sectionTruncated,
    });
  });

  return {
    path,
    binary: false,
    malformed: parse.malformed,
    sections,
    truncated: fileTruncated,
  };
}
