/*
 * `@feathertree/excel` に注入する deflate の展開（決定 33）。
 *
 * excel 層は Node を知らないので、ZIP の中身（raw deflate）の展開だけをここで引き受ける。
 * **`maxOutputLength` を必ず渡す**——宣言サイズを偽った ZIP 爆弾は、宣言を信じると止まらない。
 * 上限を超えると Node は `ERR_BUFFER_TOO_LARGE`（RangeError）を投げるので、それを too-large に写す。
 */

import { inflateRawSync } from 'node:zlib';
import type { InflateResult, Inflater } from '@feathertree/excel';

export const zlibInflater: Inflater = (data: Uint8Array, maxOutputLength: number): InflateResult => {
  try {
    const out = inflateRawSync(data, { maxOutputLength: Math.max(1, maxOutputLength) });
    return { ok: true, data: out };
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    if (code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) return { ok: false, reason: 'too-large' };
    return { ok: false, reason: 'broken' };
  }
};
