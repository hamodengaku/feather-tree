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
  | 'merge-branch';

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
   * 打つのは対応表 #7（`restore --worktree`）だけで、インデックスには触れない。
   * 「ステージ済みの内容は残る」ことを文言に明記するのは、ここが利用者にとって
   * 直前の挙動（ステージ済みごと HEAD へ戻す）との違いを知る唯一の場所になるため。
   */
  'discard-changes': {
    title: '未ステージの変更を破棄しますか？',
    message:
      '作業ツリーの変更が失われます（git には残らないため復元できません）。ステージ済みの内容はそのまま残ります。両方を戻すには、先に「ステージから戻す」を行ってください。',
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
