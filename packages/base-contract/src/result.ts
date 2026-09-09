/**
 * main と renderer の間で共有する汎用の結果型。
 *
 * 依存ゼロ。Node も electron も UI も知らないので、
 * main / preload / renderer / 純 Node のどこからでも安全に import できる。
 *
 * 原則（土台としての約束）:
 *   - IPC 越しに例外を投げない。必ずこの Result に包む
 *     （IPC を跨いだ例外はスタックが失われて扱いにくい）
 *   - 失敗は「利用者に見せる日本語」と「原文」の両方を運ぶ。訳して情報を失わせない
 */

/** どのアプリでも使う失敗の種別。アプリ固有の種別はこれを合併して拡張する。 */
export type BaseErrorKind =
  | 'cancelled'
  | 'invalid-path'
  | 'needs-confirmation'
  | 'not-found'
  | 'internal';

/**
 * 破壊的操作の確認内容。
 *
 * 確認は main 側で強制する。renderer が確認せずに呼んだら
 * `needs-confirmation` で拒否し、この内容をそのまま画面に出させる。
 * 「表示するだけ」にしないので、UI のバグで破壊操作が通ることがない。
 */
export interface ConfirmationDto {
  readonly action: string;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  /** 復旧手段があるか。無い操作はより強い警告を出す。 */
  readonly recoverable: boolean;
}

export interface BaseErrorDto<K extends string = BaseErrorKind> {
  readonly kind: K;
  /** そのまま画面に出せる文言。 */
  readonly message: string;
  /** 外部コマンドの stderr など原文。折りたたみ表示に使う。 */
  readonly detail?: string;
  readonly exitCode?: number;
  /** kind === 'needs-confirmation' のときだけ入る。 */
  readonly confirmation?: ConfirmationDto;
}

export type Result<T, E = BaseErrorDto> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });
