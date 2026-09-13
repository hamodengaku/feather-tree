import type { CloneOutcomeDto, CloneStageDto, CloneStageState } from '@feathertree/ipc';

/*
 * クローンの進捗表示の文言（純関数）。段階の状態遷移は main（core）が持ち、ここは見せ方だけ。
 */

/** 所要時間。1 分未満は「12秒」、1 時間未満は「3分04秒」、それ以上は「1時間02分」。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (hours > 0) return String(hours) + '時間' + pad(minutes) + '分';
  if (minutes > 0) return String(minutes) + '分' + pad(seconds) + '秒';
  return String(seconds) + '秒';
}

/** 3 桁区切り。toLocaleString は実行環境で揺れるので自前で区切る。 */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** バーの中に重ねる文字（`45% ・ 12,345 / 40,000 ・ 1.20 MiB | 2.00 MiB/s`）。 */
export function barText(stage: CloneStageDto): string {
  const parts: string[] = [];
  if (stage.percent !== null) parts.push(String(stage.percent) + '%');
  if (stage.current !== null) {
    parts.push(
      stage.total === null ? formatCount(stage.current) + ' 件' : formatCount(stage.current) + ' / ' + formatCount(stage.total),
    );
  }
  if (stage.detail !== null) parts.push(stage.detail);
  return parts.join(' ・ ');
}

/** 右端の時間。実行中は経過、閉じた段階は所要。始まっていなければ空。 */
export function stageTime(stage: CloneStageDto, now: number): string {
  if (stage.startedAt === null) return '';
  if (stage.state === 'running') return formatDuration(now - stage.startedAt);
  if (stage.endedAt === null) return '';
  return formatDuration(stage.endedAt - stage.startedAt);
}

export const STATE_MARK: Record<CloneStageState, string> = {
  pending: '○',
  running: '▶',
  done: '✓',
  skipped: '－',
  failed: '✕',
  cancelled: '■',
};

export const STATE_LABEL: Record<CloneStageState, string> = {
  pending: '待機中',
  running: '実行中',
  done: '完了',
  skipped: '省略',
  failed: '失敗',
  cancelled: '中止',
};

const GROUP_HEADING: Record<CloneStageDto['group'], string> = {
  clone: 'クローン',
  lfs: 'Git LFS',
  config: '設定',
  unshallow: '全履歴の取得',
};

/** その行の前に見出しを出すなら見出しの文字、出さないなら null（まとまりの変わり目だけ出す）。 */
export function headingBefore(stages: readonly CloneStageDto[], index: number): string | null {
  const stage = stages[index];
  if (stage === undefined) return null;
  const previous = stages[index - 1];
  if (previous !== undefined && previous.group === stage.group) return null;
  return GROUP_HEADING[stage.group];
}

/** 結果欄の見出し。 */
export function outcomeHeading(outcome: CloneOutcomeDto): string {
  if (outcome.cancelled) return outcome.session === null ? '中止しました' : '中止しました（タブは開きました）';
  switch (outcome.result) {
    case 'succeeded':
      return '完了しました';
    case 'partial':
      return outcome.session === null ? '一部の手順が失敗しました' : '一部の手順が失敗しました（タブは開きました）';
    case 'failed':
      return '失敗しました';
  }
}

/** 生ログのコピーを出すか（失敗・途中失敗・中止のとき）。 */
export function showsLog(outcome: CloneOutcomeDto): boolean {
  return outcome.log.length > 0 && (outcome.result !== 'succeeded' || outcome.cancelled);
}
