import type { CommitFileChange, CommitSummary } from '../model/types.js';

const US = String.fromCharCode(0x1f);
const NUL = String.fromCharCode(0x00);

/**
 * `git log --format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1f%b%x00`
 * の出力を解釈する（対応表 #20）。
 *
 * レコード境界は NUL。件名（%s）は改行を含まないので安全で、本文（%b）は改行を含むが
 * **最後のフィールド**なので境界を壊さない。
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

    /*
     * 本文は最後のフィールドなので、10 番目以降を US で繋ぎ直す。
     * こうしておけば本文に US が紛れ込んでも欠けない（他のフィールドと違い、
     * 本文だけは「git が生成した文字列」ではなく人が書いた任意のテキスト）。
     */
    const body = f.slice(10).join(US).replace(/[\r\n]+$/, '');

    commits.push({
      oid,
      shortOid: f[1] ?? '',
      parents,
      authorName: f[3] ?? '',
      authorEmail: f[4] ?? '',
      authoredAt: f[5] ?? '',
      committerName: f[6] ?? '',
      committerEmail: f[7] ?? '',
      committedAt: f[8] ?? '',
      subject: f[9] ?? '',
      body,
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
