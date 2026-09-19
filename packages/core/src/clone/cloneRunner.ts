import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandLog } from '@feathertree/base-core';
import {
  FETCH_ALL_BRANCHES_REFSPEC,
  GitCancelledError,
  GitNotFoundError,
  cloneRepository,
  fetchUnshallow,
  getLfsVersion,
  lfsPull,
  setFetchAllBranches,
  type GitContext,
  type GitExit,
} from '@feathertree/git';
import {
  cancelledHint,
  cloneHints,
  gitNotFoundHint,
  lfsMissingHint,
  MAX_HINTS,
  type CloneHint,
} from '../policy/cloneHints.js';
import { redactUrl } from '../policy/redactUrl.js';
import { toMappedError } from '../session/repositorySession.js';
import { CloneProgressTracker, type CloneMode, type CloneStage, type CloneStep } from './cloneProgress.js';

/*
 * クローンの手順を順に実行する（対応表 #37〜#41、飛ばす条件は同表の注記）。
 *
 * セッションが立つ前の実行なので RepositorySession.track() を通らない。
 * コマンドログへの記録（決定 16 の透明性）はここで 1 手ずつ直接行う。
 * git の失敗・中止は例外にせず、結果（ヒント・生ログ・残りのコマンド）にして返す。
 */

export interface CloneRunRequest {
  readonly url: string;
  /** 保存先の親フォルダ。#37 / #38 の cwd になる。 */
  readonly parentDir: string;
  /** 作成するフォルダ名（1 階層）。 */
  readonly name: string;
  readonly mode: CloneMode;
}

export interface CloneRunDeps {
  readonly gitPath: string;
  readonly tempDir: string;
  readonly commandLog: CommandLog;
  /**
   * この手順で実行する git すべてに足す環境変数（設定 sshKeyPath 由来の `GIT_SSH_COMMAND`）。
   * セッションが立つ前なので RepositorySession.context() を通れない。
   * **SSH の URL をクローンする場面こそ鍵が要る**ので、ここにも流す。
   */
  readonly env?: Readonly<Record<string, string>>;
  /** 段階の時刻。テストで固定できるように注入する。 */
  readonly now?: () => number;
}

export type CloneResultKind = 'succeeded' | 'partial' | 'failed';

export interface CloneRunResult {
  /** succeeded: 全手順が済んだ／partial: クローンはできたが途中で失敗・中止した／failed: クローンできなかった。 */
  readonly result: CloneResultKind;
  readonly cancelled: boolean;
  readonly target: string;
  readonly stages: CloneStage[];
  /** 失敗のヒントと警告（LFS が無い等）。 */
  readonly hints: CloneHint[];
  /** クローンしたフォルダで後から打つコマンド（シャローの推奨・大規模の残り手順）。 */
  readonly followUps: string[];
  /** コピー用の生ログ。 */
  readonly log: string;
}

/** 進捗の通知。urgent は段階の開始・終了（main は間引かずに送る）。 */
export type CloneProgressListener = (stages: CloneStage[], urgent: boolean) => void;

const CONFIG_COMMAND = "git config remote.origin.fetch '" + FETCH_ALL_BRANCHES_REFSPEC + "'";
const UNSHALLOW_COMMAND = 'git fetch --unshallow';
const LFS_PULL_COMMAND = 'git lfs pull';

const MODE_LABEL: Record<CloneMode, string> = {
  normal: '通常',
  shallow: '最新コミットのみ（シャロー）',
  large: '大規模リポジトリ向け（自動）',
};

type StepRun = { ok: true; exit: GitExit } | { ok: false; cancelled: boolean; notFound: boolean; stderr: string };

export async function runClone(
  req: CloneRunRequest,
  deps: CloneRunDeps,
  onProgress: CloneProgressListener,
  signal?: AbortSignal,
): Promise<CloneRunResult> {
  const now = deps.now ?? Date.now;
  const target = join(req.parentDir, req.name);
  const tracker = new CloneProgressTracker(req.mode, now);
  const hintCtx = { url: req.url, target, mode: req.mode };
  const log: string[] = [
    'FeatherTree クローンログ',
    '日時: ' + new Date(now()).toISOString(),
    // URL に資格情報（https://user:TOKEN@host/... 等）が埋め込まれていても、
    // 生ログ（コピー可能）にはそのまま出さない（脆弱性診断 §11）
    'URL: ' + redactUrl(req.url),
    '作成先: ' + target,
    'クローン方法: ' + MODE_LABEL[req.mode],
    '',
  ];

  const emit = (urgent: boolean): void => onProgress(tracker.snapshot(), urgent);
  const onLine = (line: string): void => {
    const fed = tracker.feed(line);
    if (fed !== 'none') emit(fed === 'structural');
  };

  /**
   * 中止されたか。関数にしてあるのは、`signal?.aborted` を直接比べると一度目の判定で型が
   * false に絞り込まれ、await を挟んだ後の判定まで「常に偽」と扱われるため（中止は非同期に起きる）。
   */
  const isAborted = (): boolean => signal?.aborted === true;

  const ctxAt = (cwd: string): GitContext => ({
    gitPath: deps.gitPath,
    cwd,
    tempDir: deps.tempDir,
    ...(deps.env === undefined || Object.keys(deps.env).length === 0 ? {} : { env: deps.env }),
    ...(signal === undefined ? {} : { signal }),
  });

  const record = (cwd: string, args: readonly string[], exitCode: number, elapsedMs: number, stderr: string): void => {
    // args には clone の引数として req.url がそのまま入る。コマンドログ（実行ログパネル）・
    // 生ログのどちらにも渡すので、ここで一括して資格情報を伏せる（脆弱性診断 §11）。
    // 実際に git へ渡す引数（cloneRepository 呼び出し）はこの関数を経由しないため影響しない。
    const safeArgs = args.map(redactUrl);
    const trimmed = redactUrl(stderr.trim());
    deps.commandLog.add({ cwd, args: safeArgs, exitCode, elapsedMs, ...(trimmed.length > 0 ? { stderr: trimmed } : {}) });
    log.push(
      '$ git ' + safeArgs.join(' '),
      '  (場所: ' + cwd + ')',
      '  終了コード ' + String(exitCode) + '（' + (elapsedMs / 1000).toFixed(1) + ' 秒）',
      ...(trimmed.length > 0 ? [cleanStderr(trimmed)] : []),
      '',
    );
  };

  /** 1 手を実行して記録する。stage を持たない手（通常クローンの LFS 確認）は step を null にする。 */
  const exec = async (
    step: CloneStep | null,
    cwd: string,
    args: readonly string[],
    body: () => Promise<GitExit>,
  ): Promise<StepRun> => {
    if (step !== null) {
      tracker.beginStep(step);
      emit(true);
    }
    const startedAt = now();
    try {
      const exit = await body();
      record(cwd, args, exit.code, exit.elapsedMs, exit.stderr);
      if (step !== null) tracker.endStep(step, 'done');
      return { ok: true, exit };
    } catch (err) {
      const cancelled = err instanceof GitCancelledError || signal?.aborted === true;
      const mapped = toMappedError(err);
      // git 自身の stderr にも URL が出ることがある（認証エラー等）。ヒント判定・生ログ・
      // 呼び出し元に返す failures にまで伝わる値なので、ここで一度だけ伏せておく
      // （record() 側でも重ねて伏せるが、redactUrl は冪等なので実害は無い）
      const stderr = cancelled ? '' : redactUrl(mapped.detail ?? mapped.message);
      record(cwd, args, mapped.exitCode ?? -1, now() - startedAt, cancelled ? '（利用者が中止）' : stderr);
      if (step !== null) tracker.endStep(step, cancelled ? 'cancelled' : 'failed');
      return { ok: false, cancelled, notFound: err instanceof GitNotFoundError, stderr };
    } finally {
      if (step !== null) emit(true);
    }
  };

  const finish = (
    result: CloneResultKind,
    cancelled: boolean,
    hints: CloneHint[],
    followUps: string[],
  ): CloneRunResult => {
    log.push('結果: ' + resultLabel(result, cancelled));
    emit(true);
    return { result, cancelled, target, stages: tracker.snapshot(), hints, followUps, log: log.join('\n') };
  };

  emit(true);
  const shallow = req.mode !== 'normal';

  // ---- #37 クローン
  const cloned = await exec(
    'clone',
    req.parentDir,
    ['clone', ...(shallow ? ['--depth', '1'] : []), req.url],
    () =>
      cloneRepository(
        ctxAt(req.parentDir),
        { url: req.url, directory: target, shallow, skipLfsSmudge: req.mode === 'large' },
        onLine,
      ),
  );
  if (!cloned.ok) {
    const later = laterSteps('clone', req.mode);
    if (!cloned.cancelled && /Clone succeeded, but checkout failed/i.test(cloned.stderr)) {
      // 履歴は取れている。書き出しを直す手順を案内し、残りの手順は止める（タブは開く）
      for (const step of later) tracker.endStep(step, 'skipped');
      return finish('partial', false, cloneHints(cloned.stderr, hintCtx), []);
    }
    for (const step of later) tracker.endStep(step, cloned.cancelled ? 'cancelled' : 'skipped');
    const hints = cloned.cancelled
      ? [cancelledHint(target, false)]
      : cloned.notFound
        ? [gitNotFoundHint()]
        : cloneHints(cloned.stderr, hintCtx);
    return finish('failed', cloned.cancelled, hints, []);
  }

  const usesLfs = await readFile(join(target, '.gitattributes'), 'utf8').then(
    (text) => /filter=lfs/.test(text),
    () => false,
  );

  // ---- 通常・シャロー: LFS を使うリポジトリのときだけ #38 で有無を確かめる
  if (req.mode !== 'large') {
    const warnings: CloneHint[] = [];
    if (usesLfs) {
      const lfsCheck = await exec(null, req.parentDir, ['lfs', 'version'], async () => {
        const lfs = await getLfsVersion(ctxAt(req.parentDir));
        if (lfs.version === null) warnings.push(lfsMissingHint());
        return lfs.exit;
      });
      if (!lfsCheck.ok && !lfsCheck.cancelled) warnings.push(lfsMissingHint());
    }
    return finish('succeeded', false, warnings, req.mode === 'shallow' ? [CONFIG_COMMAND, UNSHALLOW_COMMAND] : []);
  }

  // ---- 大規模: #38 → #39 → #40 → #41
  const failures: string[] = [];
  const warnings: CloneHint[] = [];
  const remaining: string[] = [];
  const cancelRest = (steps: readonly CloneStep[], commands: readonly string[]): CloneRunResult => {
    for (const step of steps) tracker.endStep(step, 'cancelled');
    return finish('partial', true, [cancelledHint(target, true)], [...remaining, ...commands]);
  };

  if (isAborted()) {
    return cancelRest(['lfs-check', 'lfs-pull', 'config', 'unshallow'], [LFS_PULL_COMMAND, CONFIG_COMMAND, UNSHALLOW_COMMAND]);
  }
  // クロージャの中で書き換えるので、let ではなく入れ物にする（制御フロー解析で false に固定されないように）
  const lfs = { available: false };
  const check = await exec('lfs-check', req.parentDir, ['lfs', 'version'], async () => {
    const found = await getLfsVersion(ctxAt(req.parentDir));
    lfs.available = found.version !== null;
    return found.exit;
  });
  if (!check.ok && check.cancelled) {
    return cancelRest(['lfs-pull', 'config', 'unshallow'], [LFS_PULL_COMMAND, CONFIG_COMMAND, UNSHALLOW_COMMAND]);
  }

  if (!lfs.available) {
    tracker.endStep('lfs-pull', 'skipped');
    emit(true);
    if (usesLfs) {
      warnings.push(lfsMissingHint());
      remaining.push(LFS_PULL_COMMAND);
    }
  } else {
    if (isAborted()) {
      return cancelRest(['lfs-pull', 'config', 'unshallow'], [LFS_PULL_COMMAND, CONFIG_COMMAND, UNSHALLOW_COMMAND]);
    }
    const pulled = await exec('lfs-pull', target, ['lfs', 'pull'], () => lfsPull(ctxAt(target), onLine));
    if (!pulled.ok) {
      if (pulled.cancelled) return cancelRest(['config', 'unshallow'], [LFS_PULL_COMMAND, CONFIG_COMMAND, UNSHALLOW_COMMAND]);
      // LFS の失敗は履歴の取得とは独立。残りの手順は続ける
      failures.push(pulled.stderr);
      remaining.push(LFS_PULL_COMMAND);
    }
  }

  if (isAborted()) return cancelRest(['config', 'unshallow'], [CONFIG_COMMAND, UNSHALLOW_COMMAND]);
  const configured = await exec(
    'config',
    target,
    ['config', 'remote.origin.fetch', FETCH_ALL_BRANCHES_REFSPEC],
    () => setFetchAllBranches(ctxAt(target)),
  );
  if (!configured.ok) {
    if (configured.cancelled) return cancelRest(['unshallow'], [CONFIG_COMMAND, UNSHALLOW_COMMAND]);
    failures.push(configured.stderr);
    remaining.push(CONFIG_COMMAND, UNSHALLOW_COMMAND);
    tracker.endStep('unshallow', 'skipped');
  } else {
    // ローカルパスの URL では --depth が無視され、最初から完全なリポジトリになっている
    const isShallow = await stat(join(target, '.git', 'shallow')).then(
      () => true,
      () => false,
    );
    if (!isShallow) {
      tracker.endStep('unshallow', 'skipped');
      emit(true);
    } else {
      if (isAborted()) return cancelRest(['unshallow'], [UNSHALLOW_COMMAND]);
      const unshallowed = await exec('unshallow', target, ['fetch', '--unshallow', 'origin'], () =>
        fetchUnshallow(ctxAt(target), onLine),
      );
      if (!unshallowed.ok) {
        if (unshallowed.cancelled) return cancelRest([], [UNSHALLOW_COMMAND]);
        failures.push(unshallowed.stderr);
        remaining.push(UNSHALLOW_COMMAND);
      }
    }
  }

  if (failures.length === 0) return finish('succeeded', false, warnings, remaining);
  const hints = [...warnings, ...cloneHints(failures.join('\n'), hintCtx).slice(0, MAX_HINTS)];
  return finish('partial', false, hints, remaining);
}

/** その手より後に来る手。 */
function laterSteps(step: CloneStep, mode: CloneMode): CloneStep[] {
  const order: CloneStep[] = mode === 'large' ? ['clone', 'lfs-check', 'lfs-pull', 'config', 'unshallow'] : ['clone'];
  return order.slice(order.indexOf(step) + 1);
}

function resultLabel(result: CloneResultKind, cancelled: boolean): string {
  if (cancelled) return result === 'failed' ? '中止（クローンは未完了）' : '中止（クローンは完了、残りの手順は未実行）';
  switch (result) {
    case 'succeeded':
      return '完了';
    case 'partial':
      return '一部失敗（クローンは完了）';
    case 'failed':
      return '失敗';
  }
}

/**
 * 生ログ用に stderr を整える。git は進捗を CR で上書きするので、そのまま貼ると同じ行が何百も並ぶ。
 * CR で上書きされた途中経過は捨て、各行の最後の状態だけを残す。
 */
export function cleanStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => {
      const parts = line.split('\r').filter((p) => p.length > 0);
      return parts[parts.length - 1] ?? '';
    })
    .filter((line) => line.length > 0)
    .map((line) => '  ' + line)
    .join('\n');
}
