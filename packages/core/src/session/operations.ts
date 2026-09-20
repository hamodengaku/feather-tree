import {
  applyHunks,
  applyStash as gitApplyStash,
  canBuildPatch,
  commit as gitCommit,
  createBranch as gitCreateBranch,
  discardWorktree,
  dropStash as gitDropStash,
  fetchRemote,
  mergeBranch as gitMergeBranch,
  pullCurrent,
  pushBranch,
  pushStagedStash,
  removeUntracked,
  resolveConflictBlock,
  stagePaths,
  switchBranch as gitSwitchBranch,
  switchToRemoteBranch as gitSwitchToRemoteBranch,
  unstagePaths,
  PatchBuildError,
  type ConflictChoice,
  type PatchDirection,
  type StashEntry,
} from '@feathertree/git';
import type { DestructiveAction } from '../policy/destructiveActions.js';
import type { RepositorySession } from './repositorySession.js';
import { MAX_EXPLICIT_PATHS, filterEntries, resolveTarget, type OperationTarget } from './statusView.js';

export interface OperationOutcome {
  readonly affected: number;
  readonly statusSeq: number;
}

/** renderer から届く「どの stash か」。oid は「一覧に出していたものと同じか」の指紋。 */
export interface StashSelection {
  /** `stash@{n}` の n。 */
  readonly index: number;
  readonly oid: string;
}

/**
 * stash を動かす操作の結果。
 *
 * **取り直した一覧をそのまま返す**のは、renderer に往復をもう 1 回させないため
 * （どの操作でも一覧は必ず取り直すので、返さないと必ず 2 回目の IPC が要る）。
 */
export interface StashOutcome {
  readonly statusSeq: number;
  readonly stashes: readonly StashEntry[];
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
  constructor(message = '表示中の差分が古くなっています。一覧を更新してからやり直してください。') {
    super(message);
    this.name = 'StaleDiffError';
  }
}

/**
 * renderer が指した stash が、いま git が持っているものと食い違っている（決定 31）。
 *
 * `StaleDiffError` と同じ思想だが、**取り違えたときの被害が段違い**なので独立させてある:
 * `stash@{n}` の n は drop / pop のたびにずれるので、一覧が古いまま `drop` を打つと
 * **別の stash が不可逆に消える**。適用の直前に #28 を打ち直し、
 * 「n 番目の oid が renderer の言う oid と同じか」を照合してから git を起動する。
 */
export class StaleStashError extends Error {
  constructor(
    message = '表示中の stash 一覧が古くなっています。一覧を更新してからやり直してください。',
  ) {
    super(message);
    this.name = 'StaleStashError';
  }
}

/**
 * マーカーの形が読めないので採用できない（入れ子・閉じていない・バイナリ）。
 *
 * 表示側もこの条件ではボタンを出さないので、ここへ来るのは食い違いが起きたときだけ。
 * 中途半端に書き戻すと本文を壊すため、**何も書かずに断る**。
 */
export class ConflictUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictUnsupportedError';
  }
}

/** renderer から届く「どの衝突か」。行番号と各側の行数は、表示していたものと同じかの指紋。 */
export interface ConflictSelection {
  readonly index: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly ourCount: number;
  readonly theirCount: number;
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
   * 衝突 1 件を採用して作業ツリーへ書き戻す（対応表の対象外。**git は 0 プロセス**）。
   *
   * hunk の適用（#33 / #34）と同じ手順を踏む:
   *   1. 書く直前にファイルを読み直す
   *   2. 表示していたものと同じ形か照合する（違えば StaleDiffError）
   *   3. **読み直した側**から新しい本文を作る
   *
   * renderer から本文を受け取らないのは hunk と同じ理由（決定「やらないこと」の
   * 「パッチ文字列を renderer で組み立てない」）。届くのは座標と指紋だけ。
   *
   * インデックスには触れないので status は変わらない。**`git status` を打ち直さない**
   * （変わらないと分かっているものを取り直すのは、決定「やらないこと」に反する）。
   *
   * @returns このファイルに残っている衝突の数。
   */
  async resolveConflict(
    path: string,
    selection: ConflictSelection,
    choice: ConflictChoice,
    signal?: AbortSignal,
  ): Promise<{ readonly remaining: number }> {
    const fresh = await this.#session.readConflict(path, signal);
    if (fresh === null) {
      throw new StaleDiffError('対象のファイルが作業ツリーにありません。一覧を更新してください。');
    }
    if (fresh.binary) throw new ConflictUnsupportedError('バイナリファイルは採用できません。');
    if (fresh.malformed) {
      throw new ConflictUnsupportedError(
        'コンフリクトマーカーの対応が取れていません。外部ツールで解決してください。',
      );
    }

    const block = fresh.blocks[selection.index];
    // 行番号と各側の行数が一致しなければ、表示してから誰かがファイルを書き換えている
    if (
      block === undefined ||
      block.startLine !== selection.startLine ||
      block.endLine !== selection.endLine ||
      block.ourCount !== selection.ourCount ||
      block.theirCount !== selection.theirCount
    ) {
      throw new StaleDiffError(
        '表示中のコンフリクトがファイルの現在の内容と食い違っています。差分を取り直してからやり直してください。',
      );
    }

    await this.#session.writeConflict(path, resolveConflictBlock(fresh.lines, block, choice), signal);
    // 消したのは 1 ブロックだけで、他のブロックの中身は動かない
    return { remaining: fresh.blocks.length - 1 };
  }

  /**
   * 対応表 #7。**不可逆なので確認必須。**
   *
   * **インデックスには触れない**（2026-09-19 改定、決定 16 の追記）。
   * `restore --worktree` はインデックスから作業ツリーを復元するので、ステージ済みの内容は残る。
   *
   * 以前はステージ済みの変更があると #8（`restore --staged --worktree`）へ自動で切り替えて
   * いたが、作業ツリーペインの「未ステージ」グループには**一部をステージした後さらに編集した
   * ファイル**（`staged != .` かつ `worktree != .`）も入るため、「未ステージ分を捨てる」つもりの
   * 操作がインデックスまで HEAD に戻していた。#8 は廃止（対応表では欠番）。
   * HEAD まで戻したいときは #6（ステージから戻す）→ #7（破棄）の 2 段階を踏む。
   */
  async discard(target: OperationTarget, signal?: AbortSignal): Promise<OperationOutcome> {
    const paths = this.#resolve(target);
    if (paths.length === 0) return { affected: 0, statusSeq: this.#session.statusSeq };

    await this.#session.track(['restore', '--worktree'], () =>
      discardWorktree(this.#session.context(signal), paths),
    );

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
    /*
     * ブランチ一覧も取り直す（対応表の例外「コミット後の反映: #10 → #2 → #3」）。
     *
     * ahead が 1 進むのがひとつ。もうひとつは **HEAD の件名の出所が #3 しかない**こと
     * （#2 は件名を持たない）。取り直さないと、リポジトリタブに 1 つ前の件名が残る。
     */
    await this.#session.refreshBranches(signal);
    return { oid, statusSeq: this.#session.statusSeq };
  }

  /**
   * 対応表 #12。確認不要（決定: ブランチ移動は無確認で即実行する）。
   * 未コミットの変更で上書きが発生する場合は git 自身が失敗させる（エラーメッセージで案内）。
   * 切替後は status のみ再取得する（docs/02-git-command-map.md「切替後の反映」）。
   */
  async switchBranch(
    branchName: string,
    signal?: AbortSignal,
  ): Promise<{ readonly statusSeq: number; readonly branchesRefreshed: boolean }> {
    await this.#session.track(['switch'], () => gitSwitchBranch(this.#session.context(signal), branchName));
    await this.#session.refreshStatus(signal);
    return { statusSeq: this.#session.statusSeq, branchesRefreshed: false };
  }

  /**
   * 対応表 #47。リモートブランチ（`<remote>/<branch>`）をローカルへ取り出して切り替える。
   * リモートペインのダブルクリックの実体。確認不要（#12 と同じ扱い）。
   *
   * 切替と違い、**ローカル追跡ブランチが 1 本増える**ので一覧も取り直す。
   * 取り直さないとローカル側にその枝が出ず、現在位置の印もどこにも付かない
   * （対応表の例外「リモートブランチの取り出し後の反映: #47 → #2 → #3」）。
   */
  async switchToRemoteBranch(
    remoteBranch: string,
    signal?: AbortSignal,
  ): Promise<{ readonly statusSeq: number; readonly branchesRefreshed: boolean }> {
    await this.#session.track(['switch', '--track'], () =>
      gitSwitchToRemoteBranch(this.#session.context(signal), remoteBranch),
    );
    await this.#session.refreshStatus(signal);
    await this.#session.refreshBranches(signal);
    return { statusSeq: this.#session.statusSeq, branchesRefreshed: true };
  }

  /**
   * 対応表 #14。確認不要。作成して切替までを 1 git プロセスで行う（`switch -c`）。
   * push は行わない。
   *
   * 切替（#12）と違い、**ローカル枝が 1 本増える**のでブランチ一覧も取り直す（#47 と同じ理由）。
   * **作ったブランチは #3 の結果にしか現れない**ので、取り直さないとブランチペインに
   * 出ないまま現在ブランチの印だけが消える
   * （対応表の例外「ブランチ作成（作成して切替）後の反映: #14 → #2 → #3」）。
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
    await this.#session.refreshBranches(signal);
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
    try {
      await this.#session.track(['merge'], () => gitMergeBranch(this.#session.context(signal), branchName));
    } catch (err) {
      // 競合は「作業ツリーを変えたまま失敗する」。取り直さないと、競合したファイルが
      // どこにも出ないまま「失敗しました」とだけ言うことになる（#35 → #2）。
      // ブランチの先端は動いていないので #3 は打たない。
      await this.#refreshStatusQuietly(signal);
      throw err;
    }
    await this.#session.refreshStatus(signal);
    await this.#session.refreshBranches(signal);
    return { statusSeq: this.#session.statusSeq };
  }

  /**
   * 失敗の後始末としての status 再取得。
   *
   * ここで投げると**本来のエラー（競合）が握りつぶされる**ので、取り直しに失敗しても
   * 黙って諦める（表示が古いまま残るだけで、利用者は「更新」で追いつける）。
   */
  async #refreshStatusQuietly(signal?: AbortSignal): Promise<void> {
    try {
      await this.#session.refreshStatus(signal);
    } catch {
      // 握りつぶす（呼び出し元が元のエラーを投げ直す）
    }
  }

  /** #refreshStatusQuietly のブランチ一覧版。 */
  async #refreshBranchesQuietly(signal?: AbortSignal): Promise<void> {
    try {
      await this.#session.refreshBranches(signal);
    } catch {
      // 握りつぶす（同上）
    }
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
    try {
      await this.#session.track(['pull'], () => pullCurrent(this.#session.context(signal)));
    } catch (err) {
      /*
       * pull は fetch + merge。競合で落ちたときは作業ツリーが競合状態で残り、
       * **fetch の分だけリモート追跡ブランチも進んでいる**ので、マージと違って
       * 一覧も取り直す（#23 → #2 → #3）。
       */
      await this.#refreshStatusQuietly(signal);
      await this.#refreshBranchesQuietly(signal);
      throw err;
    }
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

  /* ---------------------------------------------------------------- stash（決定 31） */

  /**
   * 対応表 #27: **ステージした差分だけ**を stash に退避する。確認不要
   * （退避した内容は stash に残るので不可逆ではない）。
   *
   * **失敗しても #2 を打ち直す。** ステージした差分と未ステージの差分が近接していると、
   * git は stash を積んだ後に「退避分を作業ツリーから取り除く」段で失敗する
   * （`Cannot remove worktree changes`、exit 1）。このとき stash だけができているので、
   * 取り直さないと画面が嘘になる（docs/02-git-command-map.md #27 の実測表 5 行目）。
   *
   * 失敗時の #28 は呼び出し側が打つ——例外で返る経路に一覧を載せられないため。
   *
   * メッセージの検証（制御文字・長さ）は main が済ませている前提
   * （`policy/stashMessage.ts`。`git config` の値と同じで、ここが実質の唯一の防壁）。
   */
  async saveStash(message: string, signal?: AbortSignal): Promise<StashOutcome> {
    try {
      await this.#session.track(['stash', 'push', '--staged'], () =>
        pushStagedStash(this.#session.context(signal), message),
      );
    } catch (err) {
      // 取り直しの失敗で本来の理由を隠さない（利用者が読むべきなのは git の言い分）
      await this.#session.refreshStatus(signal).catch(() => undefined);
      throw err;
    }

    await this.#session.refreshStatus(signal);
    return { statusSeq: this.#session.statusSeq, stashes: await this.#session.listStashes(signal) };
  }

  /**
   * 対応表 #29 / #30: stash をブランチへ展開する。確認不要。
   *
   * `drop` が真なら `pop`（展開して一覧から消す）、偽なら `apply`（展開して残す）。
   * **どちらも `--index` は付けない**（理由は決定 31 と git 層の `applyStash` のコメント）。
   * そのうえで **`#unstageRestored` で未ステージに揃える**——素の git は新規ファイルだけを
   * ステージ済みで戻すので、そこだけ食い違うため。
   *
   * 展開すると作業ツリーが動くので #2 は必須。一覧が変わるのは `pop` のときだけなので、
   * `apply` では #28 を打ち直さず**照合で取った一覧をそのまま返す**
   * （「変わらないと分かっているものを取り直さない」）。
   */
  async applyStash(
    selection: StashSelection,
    drop: boolean,
    signal?: AbortSignal,
  ): Promise<StashOutcome> {
    const verified = await this.#verifyStash(selection, signal);
    // 揃え直す対象を決めるには、展開の**前**のステージ済み集合が要る
    const stagedBefore = this.#stagedPaths();

    await this.#session.track(['stash', drop ? 'pop' : 'apply'], () =>
      gitApplyStash(this.#session.context(signal), selection.index, drop),
    );

    await this.#session.refreshStatus(signal);
    await this.#unstageRestored(stagedBefore, signal);

    const stashes = drop ? await this.#session.listStashes(signal) : verified;
    return { statusSeq: this.#session.statusSeq, stashes };
  }

  /**
   * 展開で**新しくステージ済みになったパスだけ**を未ステージへ戻す（決定 31 の追記）。
   *
   * 素の `stash pop` / `apply` は、変更（`M`）と削除（`D`）は未ステージで戻すが、
   * **新規ファイル（`A`）だけはステージ済みで戻す**（index に載せないと「新規ファイルがある」ことを
   * 表現できないという git の都合。実測は docs/02-git-command-map.md の表）。
   * そのままだと「セーブモードでステージしたものが、解放すると一部だけステージ済みで返る」
   * という食い違いになるので、#6 を 1 回だけ打って揃える。
   *
   * **全ステージ済みを対象にしてはいけない。** 展開の前から利用者が自分でステージしていた分は
   * pop を跨いでもそのまま残る（実測）ので、まとめて戻すと**他人の作業を巻き戻す**ことになる。
   * 前後の差を取って、増えた分だけに絞る。
   *
   * 増えていなければ git は 1 プロセスも増えない（変更だけの stash が該当する）。
   */
  async #unstageRestored(stagedBefore: ReadonlySet<string>, signal?: AbortSignal): Promise<void> {
    const restored = [...this.#stagedPaths()].filter((p) => !stagedBefore.has(p));
    if (restored.length === 0) return;

    await this.#session.track(['restore', '--staged'], () =>
      unstagePaths(this.#session.context(signal), restored),
    );
    await this.#session.refreshStatus(signal);
  }

  /**
   * いまステージ済みのパス。
   *
   * 判定は `targetHasStaged` と同じ（`ordinary` / `renamed` で `staged !== '.'`）。
   * 未追跡・無視・未マージは「ステージ済み」の対象にしない——未追跡はそもそも index に無く、
   * 未マージは `restore --staged` の相手として意味が違う（解決は利用者の仕事。決定 30）。
   */
  #stagedPaths(): ReadonlySet<string> {
    const snapshot = this.#session.snapshot;
    if (snapshot === null) return new Set();
    return new Set(
      snapshot.entries
        .filter((e) => (e.kind === 'ordinary' || e.kind === 'renamed') && e.staged !== '.')
        .map((e) => e.path),
    );
  }

  /**
   * 対応表 #31: stash を破棄。**不可逆なので確認必須。**
   *
   * **#2 は打たない。** `drop` は reflog から 1 件外すだけで、index も作業ツリーも動かない
   * （取り直しても同じ status が返る）。一覧からは消えるので #28 だけ取り直す。
   */
  async dropStash(selection: StashSelection, signal?: AbortSignal): Promise<StashOutcome> {
    await this.#verifyStash(selection, signal);

    await this.#session.track(['stash', 'drop'], () =>
      gitDropStash(this.#session.context(signal), selection.index),
    );

    return { statusSeq: this.#session.statusSeq, stashes: await this.#session.listStashes(signal) };
  }

  /**
   * 打つ直前に #28 を取り直し、renderer が指した `stash@{n}` が本当にその stash かを確かめる。
   *
   * hunk 適用の前に diff を取り直すのと同じ手順だが、**こちらは外さないと不可逆**である点が違う。
   * 決定 14 によりファイル監視もポーリングもしないので、手元の一覧は
   * 「別のターミナルで stash を積んだ／落とした」だけで簡単に古くなる。
   * 番号はそのたびにずれるので、番号だけを信じると**別の stash を pop / drop する**。
   *
   * @returns 取り直した一覧（呼び出し側が結果として使い回せる）。
   */
  async #verifyStash(
    selection: StashSelection,
    signal?: AbortSignal,
  ): Promise<readonly StashEntry[]> {
    if (!Number.isSafeInteger(selection.index) || selection.index < 0) {
      throw new StaleStashError('stash の指定が不正です。');
    }

    const stashes = await this.#session.listStashes(signal);
    const found = stashes.find((s) => s.index === selection.index);
    if (found === undefined || found.oid !== selection.oid) throw new StaleStashError();
    return stashes;
  }

  /**
   * この操作に必要な確認の種類。null なら確認不要。
   *
   * 破棄の確認は 1 種類だけになった（2026-09-19、#8 の廃止に伴う）。
   * `hasStaged` は呼び出し側の互換のために受けるだけで、**判定には使わない**。
   */
  static confirmationFor(
    operation:
      | 'stage'
      | 'unstage'
      | 'discard'
      | 'deleteUntracked'
      | 'commit'
      | 'merge'
      | 'stashSave'
      | 'stashApply'
      | 'stashDrop',
    context: { readonly amend?: boolean; readonly hasStaged?: boolean } = {},
  ): DestructiveAction | null {
    switch (operation) {
      case 'discard':
        return 'discard-changes';
      case 'deleteUntracked':
        return 'delete-untracked';
      case 'commit':
        return context.amend === true ? 'amend-pushed-commit' : null;
      case 'merge':
        return 'merge-branch';
      /*
       * stash（決定 31）。確認が要るのは破棄だけ。
       * 保存は内容が stash に残り、展開は作業ツリーへ足すだけなので、どちらも不可逆ではない
       * （決定 16 —「不可逆なもの、および履歴が動くもののみ確認する」）。
       */
      case 'stashDrop':
        return 'stash-drop';
      case 'stashSave':
      case 'stashApply':
      case 'stage':
      case 'unstage':
        return null;
    }
  }

  /**
   * 対象にステージ済みの変更が含まれるか。
   *
   * @deprecated 2026-09-19 に用途が無くなった（破棄の確認文言が 1 種類になったため）。
   * まだ `packages/main/src/handlers/service.ts` の discard ハンドラが呼んでいるので残してある。
   * 呼び出し側を消すのは統合時。結果は `confirmationFor` の判定に影響しない。
   */
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
