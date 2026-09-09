import type { BranchRef } from '../model/types.js';

const US = String.fromCharCode(0x1f);

/**
 * `git for-each-ref` の出力を解釈する。
 * フォーマットは docs/02-git-command-map.md「ブランチ一覧」の通り。
 *
 * `git branch` ではなく for-each-ref を使う理由: 出力が安定していてパースが確実、かつ高速。
 * ブランチ名に制御文字は使えないため、レコードは改行区切りで安全。
 */
export function parseRefList(stdout: string): BranchRef[] {
  const refs: BranchRef[] = [];

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const f = line.split(US);
    const refName = f[0];
    const oid = f[1];
    if (refName === undefined || oid === undefined) continue;

    const isRemote = refName.startsWith('refs/remotes/');
    // refs/remotes/<remote>/HEAD は象徴参照なので一覧には出さない
    if (isRemote && refName.endsWith('/HEAD')) continue;

    const shortName = isRemote
      ? refName.slice('refs/remotes/'.length)
      : refName.startsWith('refs/heads/')
        ? refName.slice('refs/heads/'.length)
        : refName;

    const upstreamRaw = f[3] ?? '';
    const track = f[4] ?? '';

    refs.push({
      refName,
      shortName,
      isRemote,
      isHead: (f[2] ?? '') === '*',
      oid,
      upstream: upstreamRaw.length > 0 ? upstreamRaw : null,
      ahead: matchCount(track, 'ahead'),
      behind: matchCount(track, 'behind'),
      gone: track.includes('gone'),
      committedAt: f[5] ?? '',
      subject: f[6] ?? '',
    });
  }

  return refs;
}

function matchCount(track: string, keyword: string): number {
  const m = new RegExp(`${keyword} ([0-9]+)`).exec(track);
  if (m === null) return 0;
  return Number.parseInt(m[1] ?? '0', 10);
}
