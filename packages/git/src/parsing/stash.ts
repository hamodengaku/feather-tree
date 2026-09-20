import type { StashEntry } from '../model/types.js';

const US = String.fromCharCode(0x1f);
const NUL = String.fromCharCode(0x00);

/** `stash@{12}` から 12 を取り出す。形が違えば null（並び順で補わない）。 */
function indexOfSelector(selector: string): number | null {
  const m = /^stash@\{([0-9]+)\}$/.exec(selector);
  if (m === null) return null;
  const n = Number.parseInt(m[1] ?? '', 10);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * `git stash list --format=%gd%x1f%H%x1f%P%x1f%aI%x1f%gs%x00` の出力を解釈する（対応表 #28）。
 *
 * レコード境界は NUL。`%gs`（reflog の件名）は**改行を空白へ潰す**ので境界は壊れないが、
 * `US` はそのまま通る（実測）。件名は最後のフィールドなので、**5 番目以降を US で繋ぎ直して**
 * 欠けないようにする（`parseLog` が本文に対してやっているのと同じ）。
 *
 * 番号（`stash@{n}` の n）は**並び順から作らない**。`%gd` が持っている値をそのまま使い、
 * 形が違う行は捨てる——番号は `apply` / `pop` / `drop` にそのまま渡る値なので、
 * 「たぶんこの位置だからこの番号だろう」で埋めると**別の stash を消しうる**。
 */
export function parseStashList(stdout: string): StashEntry[] {
  const entries: StashEntry[] = [];

  for (const record of stdout.split(NUL)) {
    if (record.length === 0) continue;
    // git は各レコードの後に改行も出すため取り除く
    const clean = record.replace(/^[\r\n]+/, '');
    if (clean.length === 0) continue;

    const f = clean.split(US);
    const selector = f[0] ?? '';
    const oid = f[1] ?? '';
    const index = indexOfSelector(selector);
    if (index === null || oid.length === 0) continue;

    entries.push({
      index,
      ref: selector,
      oid,
      parents: (f[2] ?? '').split(' ').filter((p) => p.length > 0),
      authoredAt: f[3] ?? '',
      message: f.slice(4).join(US).replace(/[\r\n]+$/, ''),
    });
  }

  return entries;
}
