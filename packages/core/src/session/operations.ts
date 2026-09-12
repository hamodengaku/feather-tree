import {
  applyHunks,
  canBuildPatch,
  commit as gitCommit,
  createBranch as gitCreateBranch,
  discardStagedAndWorktree,
  discardWorktree,
  fetchRemote,
  mergeBranch as gitMergeBranch,
  pullCurrent,
  pushBranch,
  removeUntracked,
  stagePaths,
  switchBranch as gitSwitchBranch,
  unstagePaths,
  PatchBuildError,
  type PatchDirection,
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
 * View が表示していた diff が、ディスク上の実際の状態と食い違っている。
 *
 * 決定 14 によりファイル監視もポーリングもしないので、表示中の diff は古くなりうる。
 * 古い行番号のまま apply すると、git が文脈を頼りに**別の場所へ**当ててしまうため、
 * 適用の直前に取り直して照合する。
 */
export class StaleDiffError extends Error {
  constructor() {
    super('表示中の差分が古くなっています。一覧を更新してからやり直してください。');
    this.name = 'StaleDiffError';
  }
}

/** renderer から届く hunk / 行の指定。header と lineCount はズレ検出用の指紋。 */
export interface HunkSelection {
  readonly index: number;
  readonly header: string;
  readonly lineCount: number;
  /** hunk.lines のインデックス。null なら hunk 全体。 */
  readonly lines: readonly number[] | null;
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
   * 対応表 #33: 選択された hunk / 行だけを index に入れる。確認不要
   * （`apply --cached` は作業ツリーに触れないので不可逆ではない）。
   */
  stageHunks(
    path: string,
    hunks: readonly HunkSelection[],
    signal?: AbortSignal,
  ): Promise<OperationOutcome> {
    return this.#applyHunks(path, hunks, 'stage', signal);
  }

  /** 対応表 #34: 選択された hunk / 行だけを index から戻す。確認不要。 */
  unstageHunks(
    path: string,
    hunks: readonly HunkSelection[],
    signal?: AbortSignal,
  ): Promise<OperationOutcome> {
    return this.#applyHunks(path, hunks, 'unstage', signal);
  }

  /**
   * 適用の直前に diff を取り直し、View が見ていたものと同じ形か確かめてから当てる
   * （docs/02-git-command-map.md「複数プロセスを許可する例外」）。
   *
   * パッチは**取り直した側**から作る。View が送ってくるのは座標と指紋だけで、
   * パッチ本体は送らせない（送らせると対象ファイルを renderer が決められてしまい、
   * パスの検証を迂回できる。docs/00-decisions.md「やらないこと」）。
   */
  async #applyHunks(
    path: string,
    hunks: readonly HunkSelection[],
    direction: PatchDirection,
    signal?: AbortSignal,
  ): Promise<OperationOutcome> {
    if (hunks.length === 0) throw new PatchBuildError('empty-selection');

    const staged = direction === 'unstage';
    const fresh = await this.#session.getDiffForPatch(path, staged, signal);
    if (fresh === null) throw new StaleDiffError();

    // git を起動する前に、そもそも hunk 単位で扱える diff かを見る。
    // 判定は DTO の hunkStageable と同じ関数なので、UI の出し分けとずれない
    const refusal = canBuildPatch(fresh);
    if (refusal !== null) throw new PatchBuildError(refusal);

    for (const request of hunks) {
      const target = fresh.hunks[request.index];
      // ヘッダには開始行・両側の行数・関数名が入っているので、編集されればまず変わる
      if (
        target === undefined ||
        target.header !== request.header ||
        target.lines.length !== request.lineCount
      ) {
        throw new StaleDiffError();
      }
    }

    const contextLines = this.#session.diffContextLines;
    const picks = hunks.map((h) => ({ index: h.index, lines: h.lines }));

    const affected = await this.#session.track(['apply', '--cached'], () =>
      applyHunks(this.#session.context(signal), fresh, picks, direction, { contextLines }),
    );

    await this.#session.refreshStatus(signal);
    return { affected, statusSeq: this.#session.statusSeq };
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

  /**
   * 対応表 #35。現在のブランチへ <branchName> を取り込む。確認が必要（決定 16）。
   *
   * 切替・作成と違い、ブランチ一覧も取り直す。マージで HEAD が進むと
   * 一覧側の ahead/behind が実際とずれるため（docs/02-git-command-map.md「マージ後の反映」）。
   * コンフリクトは git が exit != 0 で返し、競合ファイルは作業ツリーに残る。
   * 自動 abort はしない（利用者が外部ツールで解決するか、自分で abort する）。
   */
  async mergeBranch(branchName: string, signal?: AbortSignal): Promise<{ readonly statusSeq: number }> {
    await this.#session.track(['merge'], () => gitMergeBranch(this.#session.context(signal), branchName));
    await this.#session.refreshStatus(signal);
    await this.#session.refreshBranches(signal);
    return { statusSeq: this.#session.statusSeq };
  }

  /*
   * リモート操作（対応表 #22〜#25）。3 つとも確認は不要（決定 16 — 確認が要るのは
   * 強制プッシュだけで、それは未実装）。
   *
   * 3 つとも実行後に status とブランチ一覧を取り直す。リモート追跡ブランチが動けば
   * ahead/behind が必ず変わり、取り直さないとブランチペインの数字が嘘になるため
   * （docs/02-git-command-map.md「フェッチ / プル / プッシュ後の反映」）。
   */

  /** 対応表 #22。作業ツリーは動かないが、追跡ブランチが動くので一覧は取り直す。 */
  async fetch(remote: string, signal?: AbortSignal): Promise<{ readonly statusSeq: number }> {
    await this.#session.track(['fetch', remote], () =>
      fetchRemote(this.#session.context(signal), remote),
    );
    await this.#session.refreshStatus(signal);
    await this.#session.refreshBranches(signal);
    return { statusSeq: this.#session.statusSeq };
  }

  /** 対応表 #23。上流が無ければ git 自身が失敗する（先回りして判定しない）。 */
  async pull(signal?: AbortSignal): Promise<{ readonly statusSeq: number }> {
    await this.#session.track(['pull'], () => pullCurrent(this.#session.context(signal)));
    await this.#session.refreshStatus(signal);
    await this.#session.refreshBranches(signal);
    return { statusSeq: this.#session.statusSeq };
  }

  /** 対応表 #24 / #25。setUpstream が真なら --set-upstream を付ける。 */
  async push(
    remote: string,
    branch: string,
    setUpstream: boolean,
    signal?: AbortSignal,
  ): Promise<{ readonly statusSeq: number }> {
    const label = setUpstream ? ['push', '--set-upstream', remote, branch] : ['push', remote, branch];
    await this.#session.track(label, () =>
      pushBranch(this.#session.context(signal), remote, branch, setUpstream),
    );
    await this.#session.refreshStatus(signal);
    await this.#session.refreshBranches(signal);
    return { statusSeq: this.#session.statusSeq };
  }

  /** この操作に必要な確認の種類。null なら確認不要。 */
  static confirmationFor(
    operation: 'stage' | 'unstage' | 'discard' | 'deleteUntracked' | 'commit' | 'merge',
    context: { readonly amend?: boolean; readonly hasStaged?: boolean } = {},
  ): DestructiveAction | null {
    switch (operation) {
      case 'discard':
        return context.hasStaged === true ? 'discard-staged-and-worktree' : 'discard-changes';
      case 'deleteUntracked':
        return 'delete-untracked';
      case 'commit':
        return context.amend === true ? 'amend-pushed-commit' : null;
      case 'merge':
        return 'merge-branch';
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
