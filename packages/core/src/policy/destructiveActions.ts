/**
 * 確認ダイアログを要する操作を列挙する唯一の場所（docs/00-decisions.md 決定 16）。
 * View 側に判定を散らさない。
 *
 * 方針: **不可逆なもの、および履歴が動くものだけ確認する。**
 * ステージング・ブランチ移動・コミットは無確認で即実行する（軽量な操作感のため）。
 */
export type DestructiveAction =
  | 'discard-changes'
  | 'delete-untracked'
  | 'force-push'
  | 'delete-unmerged-branch'
  | 'stash-drop'
  | 'amend-pushed-commit'
  | 'merge-branch'
  | 'overwrite-conflict-worktree'
  | 'abort-merge';

export interface ConfirmationSpec {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  /** 復旧手段があるか。無い操作はより強い警告を出す。 */
  readonly recoverable: boolean;
}

const SPECS: Record<DestructiveAction, ConfirmationSpec> = {
  /*
   * 破棄の確認はこの 1 種類だけ（2026-09-19、決定 16 の追記）。
   * 打つのは対応表 #7（`restore --worktree`）と、選択に未追跡が混ざるときの #9（2026-09-30）。
   * インデックスには触れない。
   * 「ステージ済みの内容は残る」ことを文言に明記するのは、ここが利用者にとって
   * 直前の挙動（ステージ済みごと HEAD へ戻す）との違いを知る唯一の場所になるため。
   */
  'discard-changes': {
    title: '未ステージの変更を破棄しますか？',
    message:
      '作業ツリーの変更が失われます（git には残らないため復元できません）。選択に未追跡ファイルが含まれる場合、それらはディスクから削除されます。ステージ済みの内容はそのまま残ります。両方を戻すには、先に「ステージから戻す」を行ってください。',
    confirmLabel: '破棄する',
    recoverable: false,
  },
  'delete-untracked': {
    title: '未追跡ファイルを削除しますか？',
    message: 'git が管理していないファイルをディスクから削除します。復元できません。',
    confirmLabel: '削除する',
    recoverable: false,
  },
  'force-push': {
    title: '強制プッシュしますか？',
    message: 'リモートの履歴を書き換えます。他の人の作業に影響する可能性があります。',
    confirmLabel: '強制プッシュ',
    recoverable: false,
  },
  'delete-unmerged-branch': {
    title: '未マージのブランチを削除しますか？',
    message: 'このブランチのコミットはどこからも参照されなくなります。',
    confirmLabel: '削除する',
    recoverable: true,
  },
  'stash-drop': {
    title: 'stash を破棄しますか？',
    message: '退避した変更が失われます。',
    confirmLabel: '破棄する',
    recoverable: false,
  },
  'merge-branch': {
    title: 'このブランチをマージしますか？',
    message: '現在のブランチに取り込みます。コンフリクトが起きた場合は解決が必要です。',
    confirmLabel: 'マージする',
    recoverable: true,
  },
  /*
   * Excel のコンフリクトのファイル単位の採用で、作業ツリーが自分側・相手側のどちらとも違うとき（決定 34）。
   * どちらかと同じなら同じものが index の段に残っているので確認しない。手で編集した分だけは git のどこにも無い。
   */
  'overwrite-conflict-worktree': {
    title: '作業ツリーのファイルを上書きしますか？',
    message:
      '作業ツリーのファイルは自分側・相手側のどちらとも違います（衝突の解消中に編集した可能性があります）。採用すると、その編集は失われます（git には残っていないため復元できません）。',
    confirmLabel: '上書きして採用',
    recoverable: false,
  },
  /*
   * 対応表 #51（決定 32・34）。Unity モード・Excel 差分モードの「マージをキャンセル」。
   * マージ前の状態へ戻るが、解消の途中で作業ツリーに書いたもの（「適用」で書いたもの・手での編集）は失われる。
   * もう一度マージすればコンフリクトからやり直せるが、解消の作業は戻らないので recoverable にはしない。
   */
  'abort-merge': {
    title: 'マージをキャンセルしますか？',
    message:
      '作業ツリーと index をマージを始める前の状態に戻します。コンフリクトの解消のために適用した内容や編集は失われます（復元できません。もう一度マージすればコンフリクトからやり直せます）。',
    confirmLabel: 'マージをキャンセル',
    recoverable: false,
  },
  'amend-pushed-commit': {
    title: 'プッシュ済みのコミットを修正しますか？',
    message: '履歴が書き換わるため、強制プッシュが必要になります。',
    confirmLabel: '修正する',
    recoverable: true,
  },
};

/** 確認が必要な操作の一覧。ここに無い操作は無確認で実行する。 */
export const DESTRUCTIVE_ACTIONS: readonly DestructiveAction[] = Object.keys(SPECS) as DestructiveAction[];

export function requiresConfirmation(action: string): action is DestructiveAction {
  return Object.prototype.hasOwnProperty.call(SPECS, action);
}

export function describeAction(action: DestructiveAction): ConfirmationSpec {
  return SPECS[action];
}
