import {
  commit as gitCommit,
  createBranch as gitCreateBranch,
  discardStagedAndWorktree,
  discardWorktree,
  removeUntracked,
  stagePaths,
  switchBranch as gitSwitchBranch,
  unstagePaths,
} from '@feathertree/git';
import type { DestructiveAction } from '../policy/destructiveActions.js';
import type { RepositorySession } from './repositorySession.js';
import { MAX_EXPLICIT_PATHS, filterEntries, resolveTarget, type OperationTarget } from './statusView.js';

export interface OperationOutcome {
  readonly affected: number;
  readonly statusSeq: number;
}

export class TooManyPathsError extends Error {
  constructor(count: number) {
    super(`明示指定できるパスは ${String(MAX_EXPLICIT_PATHS)} 件までです（指定: ${String(count)} 件）`);
    this.name = 'TooManyPathsError';
  }
}

export class NoSnapshotError extends Error {
  constructor() {
    super('変更一覧が未取得です。更新してからやり直してください。');
    this.name = 'NoSnapshotError';
  }
}

/**
 * 書き込み操作。
 *
 * 重要な設計（docs/01-architecture.md 6 章）:
 *  - 対象は「範囲指定」で受け取り、パス一覧は**この層で**スナップショットから組み立てる。
 *    renderer が 10 万件のパス配列を送り返す必要がない。
 *  - 1 操作 = 1 git プロセス。status の再取得は操作後に 1 回だけ。
 */
export class SessionOperations {
  readonly #session: RepositorySession;

  constructor(session: RepositorySession) {
    this.#session = session;
  }

  /** 対応表 #5。確認不要。 */
  async stage(target: OperationTarget, signal?: AbortSignal): Promise<OperationOutcome> {
    const paths = this.#resolve(target);
    await this.#session.track(['add'], () => stagePaths(this.#session.context(signal), paths));
    await this.#session.refreshStatus(signal);
    return { affected: paths.length, statusSeq: this.#session.statusSeq };
  }

  /** 対応表 #6。確認不要。 */
  async unstage(target: OperationTarget, signal?: AbortSignal): Promise<OperationOutcome> {
    const paths = this.#resolve(target);
    await this.#session.track(['restore', '--staged'], () =>
      unstagePaths(this.#session.context(signal), paths),
    );
    await this.#session.refreshStatus(signal);
    return { affected: paths.length, statusSeq: this.#session.statusSeq };
  }

  /**
   * 対応表 #7 / #8。**不可逆なので確認必須。**
   * ステージ済みの変更も含まれる場合は #8 を使う。
   */
  async discard(target: OperationTarget, signal?: AbortSignal): Promise<OperationOutcome> {
    const snapshot = this.#snapshot();
    const paths = this.#resolve(target);
    if (paths.length === 0) return { affected: 0, statusSeq: this.#session.statusSeq };

    const targetSet = new Set(paths);
    const hasStaged = snapshot.entries.some(
      (e) => targetSet.has(e.path) && (e.kind === 'ordinary' || e.kind === 'renamed') && e.staged !== '.',
    );

    const ctx = this.#session.context(signal);
    if (hasStaged) {
      await this.#session.track(['restore', '--staged', '--worktree'], () =>
        discardStagedAndWorktree(ctx, paths),
      );
    } else {
      await this.#session.track(['restore', '--worktree'], () => discardWorktree(ctx, paths));
    }

    await this.#session.refreshStatus(signal);
    return { affected: paths.length, statusSeq: this.#session.statusSeq };
  }

  /** 対応表 #9。**不可逆なので確認必須。** */
  async deleteUntracked(target: OperationTarget, signal?: AbortSignal): Promise<OperationOutcome> {
    const snapshot = this.#snapshot();
    const requested = new Set(this.#resolve(target));
    // 未追跡以外を誤って消さないよう、この操作は未追跡エントリだけに絞る
    const paths = filterEntries(snapshot, { group: 'untracked' })
      .map((e) => e.path)
      .filter((p) => requested.has(p));

    if (paths.length === 0) return { affected: 0, statusSeq: this.#session.statusSeq };

    await this.#session.track(['clean', '-f', '-d'], () =>
      removeUntracked(this.#session.context(signal), paths),
    );
    await this.#session.refreshStatus(signal);
    return { affected: paths.length, statusSeq: this.#session.statusSeq };
  }

  /** 対応表 #10 / #11。amend は確認対象。 */
  async commit(
    message: string,
    options: { readonly amend?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<{ readonly oid: string | null; readonly statusSeq: number }> {
    const label = options.amend === true ? ['commit', '--amend'] : ['commit'];
    const oid = await this.#session.track(label, () =>
      gitCommit(this.#session.context(signal), message, options),
    );
    await this.#session.refreshStatus(signal);
    return { oid, statusSeq: this.#session.statusSeq };
  }

  /**
   * 対応表 #12。確認不要（決定: ブランチ移動は無確認で即実行する）。
   * 未コミットの変更で上書きが発生する場合は git 自身が失敗させる（エラーメッセージで案内）。
   * 切替後は status のみ再取得する（docs/02-git-command-map.md「切替後の反映」）。
   */
  async switchBranch(branchName: string, signal?: AbortSignal): Promise<{ readonly statusSeq: number }> {
    await this.#session.track(['switch'], () => gitSwitchBranch(this.#session.context(signal), branchName));
    await this.#session.refreshStatus(signal);
    return { statusSeq: this.#session.statusSeq };
  }

  /**
   * 対応表 #14。確認不要。作成して切替までを 1 git プロセスで行う（`switch -c`）。
   * push は行わない。切替後は status のみ再取得する。
   */
  async createBranch(
    name: string,
    startPoint: string,
    signal?: AbortSignal,
  ): Promise<{ readonly statusSeq: number }> {
    await this.#session.track(['switch', '-c'], () =>
      gitCreateBranch(this.#session.context(signal), name, startPoint),
    );
    await this.#session.refreshStatus(signal);
    return { statusSeq: this.#session.statusSeq };
  }

  /** この操作に必要な確認の種類。null なら確認不要。 */
  static confirmationFor(
    operation: 'stage' | 'unstage' | 'discard' | 'deleteUntracked' | 'commit',
    context: { readonly amend?: boolean; readonly hasStaged?: boolean } = {},
  ): DestructiveAction | null {
    switch (operation) {
      case 'discard':
        return context.hasStaged === true ? 'discard-staged-and-worktree' : 'discard-changes';
      case 'deleteUntracked':
        return 'delete-untracked';
      case 'commit':
        return context.amend === true ? 'amend-pushed-commit' : null;
      case 'stage':
      case 'unstage':
        return null;
    }
  }

  /** 対象にステージ済みの変更が含まれるか（確認文言の選択に使う）。 */
  targetHasStaged(target: OperationTarget): boolean {
    const snapshot = this.#session.snapshot;
    if (snapshot === null) return false;
    const paths = new Set(resolveTarget(snapshot, target));
    return snapshot.entries.some(
      (e) => paths.has(e.path) && (e.kind === 'ordinary' || e.kind === 'renamed') && e.staged !== '.',
    );
  }

  #snapshot() {
    const snapshot = this.#session.snapshot;
    if (snapshot === null) throw new NoSnapshotError();
    return snapshot;
  }

  #resolve(target: OperationTarget): readonly string[] {
    if (target.kind === 'paths' && target.paths.length > MAX_EXPLICIT_PATHS) {
      throw new TooManyPathsError(target.paths.length);
    }
    return resolveTarget(this.#snapshot(), target);
  }
}
