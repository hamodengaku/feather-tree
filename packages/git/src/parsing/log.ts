import type { CommitFileChange, CommitSummary } from '../model/types.js';

const US = String.fromCharCode(0x1f);
const NUL = String.fromCharCode(0x00);

/**
 * `git log --format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x00` の出力を解釈する。
 * 件名（%s）は改行を含まないため、NUL 区切りで確実に分割できる。
 */
export function parseLog(stdout: string): CommitSummary[] {
  const commits: CommitSummary[] = [];

  for (const record of stdout.split(NUL)) {
    if (record.length === 0) continue;
    // git log は各レコードの後に改行も出すため取り除く
    const clean = record.replace(/^[\r\n]+/, '');
    if (clean.length === 0) continue;

    const f = clean.split(US);
    const oid = f[0];
    if (oid === undefined || oid.length === 0) continue;

    const parents = (f[2] ?? '').split(' ').filter((p) => p.length > 0);

    commits.push({
      oid,
      shortOid: f[1] ?? '',
      parents,
      authorName: f[3] ?? '',
      authorEmail: f[4] ?? '',
      authoredAt: f[5] ?? '',
      subject: f[6] ?? '',
    });
  }

  return commits;
}

/**
 * `git show --name-status -z --format=` の出力を解釈する。
 *
 * NUL 区切りで `status NUL path` が並ぶ。R / C は `status NUL origPath NUL newPath`。
 */
export function parseNameStatus(stdout: string): CommitFileChange[] {
  const tokens = stdout.split(NUL).filter((t) => t.replace(/[\r\n]/g, '').length > 0);
  const changes: CommitFileChange[] = [];

  let i = 0;
  while (i < tokens.length) {
    const status = (tokens[i] ?? '').replace(/[\r\n]/g, '');
    i += 1;
    if (status.length === 0) continue;

    const isMove = status.startsWith('R') || status.startsWith('C');
    if (isMove) {
      const origPath = tokens[i];
      const path = tokens[i + 1];
      i += 2;
      if (origPath === undefined || path === undefined) break;
      changes.push({ status, path, origPath });
    } else {
      const path = tokens[i];
      i += 1;
      if (path === undefined) break;
      changes.push({ status, path, origPath: null });
    }
  }

  return changes;
}
