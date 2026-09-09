import { fail, ok, type Result } from '@feathertree/base-contract';

/**
 * IPC ハンドラの共通ラッパ。
 *
 * 土台としての約束: **IPC 越しに例外を投げない。**
 * 例外は IPC を跨ぐとスタックが失われて扱いにくいので、必ず Result に包む。
 *
 * アプリ固有のエラー写像（外部コマンドの stderr を日本語にする等）は
 * `createResultWrapper` に注入する。この層はアプリのエラー種別を知らない。
 */

/** ハンドラが意図的に返すエラー。DTO をそのまま運ぶ。 */
export class HandlerError<E> extends Error {
  readonly dto: E;

  constructor(dto: E & { message: string }) {
    super(dto.message);
    this.name = 'HandlerError';
    this.dto = dto;
  }
}

function isHandlerError<E>(err: unknown): err is HandlerError<E> {
  return err instanceof Error && err.name === 'HandlerError' && 'dto' in err;
}

/**
 * `wrap` を作る。
 *
 * @param mapError HandlerError 以外の例外をアプリのエラー DTO へ写す関数。
 */
export function createResultWrapper<E>(mapError: (err: unknown) => E) {
  return async function wrap<T>(run: () => Promise<T> | T): Promise<Result<T, E>> {
    try {
      return ok(await run());
    } catch (err) {
      if (isHandlerError<E>(err)) return fail(err.dto);
      return fail(mapError(err));
    }
  };
}
