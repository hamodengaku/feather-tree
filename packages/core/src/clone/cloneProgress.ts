/*
 * クローンの段階表と、git / git-lfs の進捗行の解析（決定 9・docs/01-architecture.md 6 章）。
 *
 * renderer に git の出力形式を知らせないため、行の解析と段階の状態遷移はここで閉じる。
 * main はスナップショットを受け取って送るだけ、renderer は受け取った表を描くだけ。
 */

export type CloneMode = 'normal' | 'shallow' | 'large';

/** 実行の単位（git 1 プロセス = 1 手）。runner はこの単位で begin / end を呼ぶ。 */
export type CloneStep = 'clone' | 'lfs-check' | 'lfs-pull' | 'config' | 'unshallow';

/** 表示上のまとまり（見出し）。 */
export type CloneStageGroup = 'clone' | 'lfs' | 'config' | 'unshallow';

export type CloneStageState = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';

export interface CloneStage {
  readonly id: string;
  /** 日本語の段階名。 */
  readonly label: string;
  /** git の原文名（Receiving objects 等）。進捗行を持たない段階はコマンド名。 */
  readonly source: string;
  readonly group: CloneStageGroup;
  readonly step: CloneStep;
  readonly state: CloneStageState;
  /** 0〜100。件数だけの段階（Enumerating objects）や未開始は null。 */
  readonly percent: number | null;
  readonly current: number | null;
  readonly total: number | null;
  /** 転送量と速度（`1.20 MiB | 2.00 MiB/s`）。 */
  readonly detail: string | null;
  /** epoch ms。 */
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

/** feed の結果。structural は段階の開始・終了を含む（main は間引かずに即送る）。 */
export type FeedResult = 'structural' | 'value' | 'none';

export type StepOutcome = 'done' | 'failed' | 'cancelled' | 'skipped';

interface StageDef {
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly group: CloneStageGroup;
  readonly step: CloneStep;
}

/** git の転送の段階（clone と fetch で共通）。 */
const TRANSFER: readonly (readonly [string, string, string])[] = [
  ['enumerate', '対象の列挙', 'Enumerating objects'],
  ['count', 'オブジェクトの計数', 'Counting objects'],
  ['compress', '圧縮', 'Compressing objects'],
  ['receive', 'データの受信', 'Receiving objects'],
  ['resolve', '差分の解決', 'Resolving deltas'],
];

/** モードごとの段階表。実行しない段階も含めて、始まる前にすべて並べる。 */
export function planStages(mode: CloneMode): StageDef[] {
  const stages: StageDef[] = TRANSFER.map(([id, label, source]) => ({
    id: 'clone-' + id,
    label,
    source,
    group: 'clone',
    step: 'clone',
  }));
  stages.push({ id: 'clone-checkout', label: 'ファイルの書き出し', source: 'Updating files', group: 'clone', step: 'clone' });
  if (mode !== 'large') {
    // 通常・シャローでは git-lfs が入っていれば書き出し中に LFS の実体を落とす（大規模では止めている）
    stages.push({ id: 'clone-filter', label: 'LFS ファイルの展開', source: 'Filtering content', group: 'clone', step: 'clone' });
    return stages;
  }
  stages.push(
    { id: 'lfs-check', label: 'Git LFS の確認', source: 'git lfs version', group: 'lfs', step: 'lfs-check' },
    { id: 'lfs-pull', label: 'LFS ファイルの取得', source: 'Downloading LFS objects', group: 'lfs', step: 'lfs-pull' },
    { id: 'config', label: '全ブランチ取得の設定', source: 'git config', group: 'config', step: 'config' },
  );
  for (const [id, label, source] of TRANSFER) {
    stages.push({ id: 'unshallow-' + id, label: '全履歴の' + label, source, group: 'unshallow', step: 'unshallow' });
  }
  return stages;
}

export interface ParsedProgress {
  readonly title: string;
  readonly percent: number | null;
  readonly current: number;
  readonly total: number | null;
  readonly detail: string | null;
  readonly done: boolean;
}

const WITH_PERCENT = /^(?:remote:\s*)?([A-Za-z][A-Za-z ]*?):\s+(\d{1,3})%\s+\((\d+)\/(\d+)\)(.*)$/;
const COUNT_ONLY = /^(?:remote:\s*)?([A-Za-z][A-Za-z ]*?):\s+(\d+)(.*)$/;

/**
 * 進捗行を 1 行解析する。形の違う行（Cloning into / remote: Total / From ...）は null。
 *
 *  - `Receiving objects:  45% (5/11), 1.20 MiB | 2.00 MiB/s`
 *  - `remote: Enumerating objects: 12, done.`
 *  - `Downloading LFS objects:  50% (1/2), 10 MB | 5.0 MB/s`
 */
export function parseProgressLine(line: string): ParsedProgress | null {
  const text = line.trim();
  const withPercent = WITH_PERCENT.exec(text);
  if (withPercent !== null) {
    const [, title = '', percent = '0', current = '0', total = '0', rest = ''] = withPercent;
    const tail = splitTail(rest);
    return {
      title,
      percent: Math.min(100, Number(percent)),
      current: Number(current),
      total: Number(total),
      ...tail,
    };
  }
  const countOnly = COUNT_ONLY.exec(text);
  if (countOnly !== null) {
    const [, title = '', current = '0', rest = ''] = countOnly;
    // `Total 12 (delta 0)` のように数字の後ろが `,` 以外で続くものは進捗ではない
    if (rest.length > 0 && !rest.startsWith(',')) return null;
    return { title, percent: null, current: Number(current), total: null, ...splitTail(rest) };
  }
  return null;
}

/** `, 1.20 MiB | 2.00 MiB/s, done.` を転送量と完了印に分ける。 */
function splitTail(rest: string): { detail: string | null; done: boolean } {
  const parts = rest
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const done = parts.some((p) => /^done\.?$/i.test(p));
  const detail = parts.filter((p) => !/^done\.?$/i.test(p)).join(', ');
  return { detail: detail.length > 0 ? detail : null, done };
}

interface MutableStage {
  def: StageDef;
  state: CloneStageState;
  percent: number | null;
  current: number | null;
  total: number | null;
  detail: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** 進捗行を 1 度でも受け取ったか。受け取らずに次へ進んだ段階は「省略」にする。 */
  seen: boolean;
}

/**
 * 段階の状態を持つ。時刻は注入できる（テストで所要時間を固定するため）。
 *
 * 状態遷移:
 *  - beginStep: その手の最初の段階を実行中にする（接続や認証で何も出ない間も動いて見せる）
 *  - feed: 行に当たる段階を実行中にし、それより前の段階を閉じる（行を受け取っていれば完了、無ければ省略）
 *  - endStep: その手に残った段階を閉じる
 */
export class CloneProgressTracker {
  readonly #stages: MutableStage[];
  readonly #now: () => number;
  #step: CloneStep | null = null;

  constructor(mode: CloneMode, now: () => number = Date.now) {
    this.#now = now;
    this.#stages = planStages(mode).map((def) => ({
      def,
      state: 'pending',
      percent: null,
      current: null,
      total: null,
      detail: null,
      startedAt: null,
      endedAt: null,
      seen: false,
    }));
  }

  beginStep(step: CloneStep): void {
    this.#step = step;
    const first = this.#inStep(step)[0];
    if (first !== undefined && first.state === 'pending') this.#start(first);
  }

  feed(line: string): FeedResult {
    const step = this.#step;
    if (step === null) return 'none';
    const parsed = parseProgressLine(line);
    if (parsed === null) return 'none';
    const stages = this.#inStep(step);
    const index = stages.findIndex((s) => s.def.source === parsed.title);
    const stage = stages[index];
    if (stage === undefined) return 'none';

    let structural = false;
    for (const earlier of stages.slice(0, index)) {
      if (earlier.state === 'running' || earlier.state === 'pending') {
        this.#close(earlier, earlier.seen ? 'done' : 'skipped');
        structural = true;
      }
    }
    if (stage.state === 'pending') {
      this.#start(stage);
      structural = true;
    }
    // 完了した段階に遅れて届いた行（同じ 100% の再表示など）は数値だけ直す
    stage.seen = true;
    stage.percent = parsed.percent;
    stage.current = parsed.current;
    stage.total = parsed.total;
    if (parsed.detail !== null) stage.detail = parsed.detail;
    if (parsed.done && stage.state === 'running') {
      if (stage.total !== null) stage.percent = 100;
      this.#close(stage, 'done');
      structural = true;
    }
    return structural ? 'structural' : 'value';
  }

  endStep(step: CloneStep, outcome: StepOutcome): void {
    const stages = this.#inStep(step);
    const single = stages.length === 1;
    for (const stage of stages) {
      if (stage.state !== 'running' && stage.state !== 'pending') continue;
      this.#close(stage, closingState(stage, outcome, single));
    }
    if (this.#step === step) this.#step = null;
  }

  snapshot(): CloneStage[] {
    return this.#stages.map((s) => ({
      id: s.def.id,
      label: s.def.label,
      source: s.def.source,
      group: s.def.group,
      step: s.def.step,
      state: s.state,
      percent: s.percent,
      current: s.current,
      total: s.total,
      detail: s.detail,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    }));
  }

  #inStep(step: CloneStep): MutableStage[] {
    return this.#stages.filter((s) => s.def.step === step);
  }

  #start(stage: MutableStage): void {
    stage.state = 'running';
    stage.startedAt = this.#now();
  }

  #close(stage: MutableStage, state: CloneStageState): void {
    stage.state = state;
    if (stage.startedAt !== null) stage.endedAt = this.#now();
    if (state === 'done' && stage.total !== null) stage.percent = 100;
  }
}

function closingState(stage: MutableStage, outcome: StepOutcome, single: boolean): CloneStageState {
  switch (outcome) {
    case 'done':
      // 1 段階だけの手（lfs version / config）は行を出さないので、実行中だったなら完了
      if (stage.state === 'running' && (stage.seen || single)) return 'done';
      return 'skipped';
    case 'failed':
      return stage.state === 'running' ? 'failed' : 'skipped';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
  }
}
