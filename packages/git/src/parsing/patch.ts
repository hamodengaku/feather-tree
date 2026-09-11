import type { DiffLineKind, FileDiff } from '../model/types.js';

/**
 * hunk / 行単位のパッチ生成器（対応表 #33 / #34、docs/00-decisions.md 決定 18）。
 *
 * I/O も描画も知らない純関数。`git apply --cached [--reverse]` にそのまま渡せる
 * unified diff を組み立てる。
 */

const LF = String.fromCharCode(10);
/** 「\ No newline at end of file」の行頭（バックスラッシュ + 空白）。 */
const NO_NEWLINE_PREFIX = String.fromCharCode(92) + String.fromCharCode(32);

/** hunk / 行単位の操作ができない理由。UI のボタン表示にもそのまま使う。 */
export type PatchRefusal =
  | 'binary'
  /** 行数上限で打ち切られている。欠けた行があるのでパッチを作れない。 */
  | 'truncated'
  /** 未追跡ファイルの合成 diff。git 由来のファイルヘッダを持たない。 */
  | 'synthesized'
  /** ファイル全体の追加・削除。部分適用の意味がなく、ヘッダの整合も取れない。 */
  | 'whole-file'
  /** リネーム。部分適用すると --reverse がリネームごと巻き戻す。 */
  | 'rename'
  /** 未マージ（diff --cc）。ハンクヘッダの形式が違う。 */
  | 'combined'
  | 'no-hunk'
  /** 選択された変更行が 1 行も無い。 */
  | 'empty-selection'
  /** 指定された hunk が存在しない。 */
  | 'no-such-hunk';

export class PatchBuildError extends Error {
  readonly refusal: PatchRefusal;

  constructor(refusal: PatchRefusal) {
    super(`パッチを生成できません: ${refusal}`);
    this.name = 'PatchBuildError';
    this.refusal = refusal;
  }
}

/** 適用の向き。`stage` は index へ、`unstage` は index から戻す（--reverse）。 */
export type PatchDirection = 'stage' | 'unstage';

export interface HunkPick {
  /** FileDiff.hunks のインデックス。 */
  readonly index: number;
  /** hunk.lines のインデックス。null なら hunk 全体。 */
  readonly lines: readonly number[] | null;
}

export interface BuiltPatch {
  readonly patch: string;
  /** パッチに載った変更行（+/-）の数。 */
  readonly changedLines: number;
}

/**
 * この diff に対して hunk / 行単位の操作ができるか。できないなら理由を返す。
 *
 * ボタンの出し分けと apply 直前のガードで同じ関数を使うことで、
 * 「UI では押せるのに main が拒否する」ずれが起きないようにする。
 */
export function canBuildPatch(diff: FileDiff): PatchRefusal | null {
  if (diff.binary) return 'binary';
  if (diff.truncated) return 'truncated';
  if (diff.preamble.length === 0) return 'synthesized';
  if (diff.hunks.length === 0) return 'no-hunk';

  const head = diff.preamble;
  const first = head[0] ?? '';
  if (first.startsWith('diff --cc') || first.startsWith('diff --combined')) return 'combined';

  const wholeFile = head.some(
    (l) =>
      l.startsWith('new file mode') ||
      l.startsWith('deleted file mode') ||
      l === '--- /dev/null' ||
      l === '+++ /dev/null',
  );
  if (wholeFile) return 'whole-file';

  if (head.some((l) => l.startsWith('rename from') || l.startsWith('copy from'))) return 'rename';

  return null;
}

/**
 * その hunk で行単位の選択を許すか。
 *
 * 末尾改行なしマーカーを含む hunk は、行を選び分けると
 * 「最終行を削除するのに改行有無マーカーが無い」不整合パッチになりうるので、
 * hunk 全体としてのみ扱う（元の hunk をそのまま再生する分には必ず整合する）。
 */
export function hunkAllowsLineSelection(diff: FileDiff, hunkIndex: number): boolean {
  const hunk = diff.hunks[hunkIndex];
  if (hunk === undefined) return false;
  return !hunk.lines.some((l) => l.kind === 'no-newline');
}

/**
 * 選択された hunk / 行だけを含むパッチを組み立てる。
 *
 * 向きの違いは「pre-image（git が読みに行く側）がどちらか」だけで決まる。
 *
 * - stage   : `apply --cached` の pre-image は old 側（＝ index の内容）
 * - unstage : `apply --cached --reverse` の pre-image は new 側（＝ index の内容）
 *
 * よって「選ばなかった変更行」は、pre-image に居るなら文脈行へ落とし、
 * 居ないなら捨てる。これで両方向が 1 本の規則で書ける。
 * パッチ自体は常に forward 形式で出し、反転は git の --reverse に任せる。
 *
 * 複数 hunk を 1 枚のパッチに載せるので（「1 操作 = 1 git プロセス」）、
 * 2 つめ以降は非権威側の開始行に累積のずれを足す必要がある。
 */
export function buildHunkPatch(
  diff: FileDiff,
  picks: readonly HunkPick[],
  direction: PatchDirection,
): BuiltPatch {
  const refusal = canBuildPatch(diff);
  if (refusal !== null) throw new PatchBuildError(refusal);

  const forward = direction === 'stage';
  const inPreimage = (kind: DiffLineKind): boolean =>
    kind === 'context' || (forward ? kind === 'removed' : kind === 'added');

  const out: string[] = [...diff.preamble];
  /** ここまでに出力した hunk が非権威側の行番号をどれだけずらしたか。 */
  let drift = 0;
  let changedLines = 0;

  for (const pick of [...picks].sort((a, b) => a.index - b.index)) {
    const hunk = diff.hunks[pick.index];
    if (hunk === undefined) throw new PatchBuildError('no-such-hunk');
    const selected = pick.lines === null ? null : new Set(pick.lines);

    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;

    /** 1 行出力する。直後の末尾改行なしマーカーは親に付いていく。 */
    const push = (i: number, marker: ' ' | '+' | '-'): void => {
      const line = hunk.lines[i];
      if (line === undefined) return;
      body.push(marker + line.text);
      if (marker === ' ') {
        oldCount += 1;
        newCount += 1;
      } else if (marker === '+') {
        newCount += 1;
      } else {
        oldCount += 1;
      }
      const next = hunk.lines[i + 1];
      if (next?.kind === 'no-newline') body.push(NO_NEWLINE_PREFIX + next.text);
    };

    /** 変更行 1 つを、選ばれたかどうかに応じて出力する（選ばれず pre-image にも居なければ捨てる）。 */
    const emitChange = (i: number): void => {
      const line = hunk.lines[i];
      if (line === undefined) return;
      if (selected === null || selected.has(i)) {
        push(i, line.kind === 'added' ? '+' : '-');
        changedLines += 1;
        return;
      }
      // pre-image に居る行を落とすと文脈がずれる。文脈行として残す
      if (inPreimage(line.kind)) push(i, ' ');
      // pre-image に居ない非選択行は、そもそも無かったことにする（マーカーも道連れ）
    };

    let i = 0;
    while (i < hunk.lines.length) {
      const line = hunk.lines[i];
      if (line === undefined) break;

      // マーカーは親と一緒に出力済み
      if (line.kind === 'no-newline') {
        i += 1;
        continue;
      }
      if (line.kind === 'context') {
        push(i, ' ');
        i += 1;
        continue;
      }

      // 変更ブロック（文脈行に挟まれた -/+ のかたまり）。git は - をまとめてから + を出す
      const removals: number[] = [];
      const additions: number[] = [];
      let end = i;
      while (end < hunk.lines.length && hunk.lines[end]?.kind !== 'context') {
        const kind = hunk.lines[end]?.kind;
        if (kind === 'removed') removals.push(end);
        else if (kind === 'added') additions.push(end);
        end += 1;
      }

      const wholeBlock =
        selected === null || [...removals, ...additions].every((n) => selected.has(n));

      if (wholeBlock) {
        // ブロックごと採るなら元の並びをそのまま再生する（byte 単位で同じパッチになる）
        for (const n of removals) emitChange(n);
        for (const n of additions) emitChange(n);
      } else {
        // 一部だけ採るときは k 番目の削除と k 番目の追加を対にして交互に出す。
        //
        // 元の並び（- をまとめてから +）のまま一部を文脈行に落とすと、
        // 残した追加行が文脈行より後ろに押し出されて別の場所に挿入される
        // （a,b,c → A,B,C で b→B だけ選ぶと a,c,B になってしまう）。
        // 文脈行と削除行の相対順序さえ保てば pre-image は変わらないので、
        // 追加行だけを対応する位置へ差し込むのは安全。
        const pairs = Math.max(removals.length, additions.length);
        for (let k = 0; k < pairs; k += 1) {
          const removal = removals[k];
          if (removal !== undefined) emitChange(removal);
          const addition = additions[k];
          if (addition !== undefined) emitChange(addition);
        }
      }

      i = end;
    }

    // 変更行が 1 つも残らなかった hunk は出さない（ずれにも寄与させない）
    if (!body.some((l) => l.startsWith('+') || l.startsWith('-'))) continue;

    // 権威側 = git が探しに行く開始行。非権威側は自由だが整合させておく
    const anchor = forward ? hunk.oldStart : hunk.newStart;
    const other = anchor + drift;
    out.push(
      forward
        ? `@@ -${anchor},${oldCount} +${other},${newCount} @@`
        : `@@ -${other},${oldCount} +${anchor},${newCount} @@`,
    );
    out.push(...body);
    drift += forward ? newCount - oldCount : oldCount - newCount;
  }

  if (changedLines === 0) throw new PatchBuildError('empty-selection');

  // 末尾は必ず改行で終える（git apply の要求）
  out.push('');
  return { patch: out.join(LF), changedLines };
}
