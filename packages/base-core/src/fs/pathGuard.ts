import { realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';

/**
 * 受け取った相対パスが、指定したルート配下に収まることを検証する。
 *
 * 土台としての意図: renderer は sandbox で動くとはいえ、
 * 渡ってくる文字列は**信頼できない入力**として扱う。
 * 絶対パスと親ディレクトリへの脱出を拒否する。
 */
export class PathOutsideRootError extends Error {
  constructor(path: string) {
    super(`許可された範囲外のパスです: ${path}`);
    this.name = 'PathOutsideRootError';
  }
}

export function assertInsideRoot(root: string, candidate: string): void {
  if (candidate.length === 0) throw new PathOutsideRootError(candidate);
  // 受け付けるのはルート相対パスのみ。絶対パスは拒否する
  if (isAbsolute(candidate)) throw new PathOutsideRootError(candidate);

  const normalized = normalize(candidate);
  if (normalized.startsWith('..')) throw new PathOutsideRootError(candidate);

  const absoluteRoot = resolve(root);
  const target = resolve(join(absoluteRoot, normalized));
  const rel = relative(absoluteRoot, target);

  if (rel.startsWith('..') || isAbsolute(rel)) throw new PathOutsideRootError(candidate);
}

/**
 * `assertInsideRoot` の文字列検証を通った絶対パスについて、**実体パス**（シンボリックリンク／
 * ジャンクション解決後）がルート配下に収まることを再検証する。
 *
 * 悪意あるリポジトリのワークツリーには、ジャンクション（Windows では管理者権限なしで作れる）
 * を仕込める。ジャンクション配下のパスは文字列上「ルート配下」に見えても、実体はリポジトリ外の
 * 任意のファイルを指せる（診断 Medium 1）。`shell.openPath` / `shell.showItemInFolder` は OS の
 * ファイルシステムをそのまま辿るため、これは実害になる。
 *
 * `git` 自身のコマンド（pathspec 経由）はこの影響を受けにくいので、ここで通すのは
 * shell 系 API の直前だけに限る（全操作に義務化すると realpath の分だけ毎回 I/O が増える）。
 *
 * 対象ファイルが存在しない場合（ENOENT）は realpath できないので、そのケースはここでは判定しない
 * （文字列検証済みのパスをそのまま返す）。「ファイルが無い」という既存の失敗経路
 * （openPath がエラー文字列を返す等）はこの後の呼び出しに委ねる。ENOTDIR も同様に扱う
 * （パスの途中にファイルが来る＝その時点で存在しないディレクトリ構造なので、意味的に ENOENT と同じ）。
 *
 * それ以外の失敗（EACCES＝権限拒否、ELOOP＝シンボリックリンクの循環、Node の realpath が
 * 正しく解決できない特殊な reparse point 等）で素通りさせるのは fail-open になる。
 * `shell.openPath` は OS のシェル層で reparse point を辿るため、Node の realpath が失敗した
 * 対象を OS 側は解決してしまう可能性があり、「Node の realpath が失敗する」ことと
 * 「OS のシェルも同じ理由で失敗する」ことは論理的に等価ではない。fail closed にして拒否する
 * （診断 Medium 1 の残存指摘）。
 *
 * 戻り値は実体パス。以降の shell 呼び出しにはこちらを渡す
 * （ジャンクションの手前ではなく、解決済みの実在パスを渡すことで判定と実行の対象を一致させる）。
 */
export async function assertRealPathInsideRoot(root: string, absoluteTarget: string): Promise<string> {
  const realRoot = await realpath(resolve(root));

  let realTarget: string;
  try {
    realTarget = await realpath(absoluteTarget);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return absoluteTarget;
    throw new PathOutsideRootError(absoluteTarget);
  }

  // Windows はファイルシステムの大文字小文字を区別しないため、比較前に大小文字を揃える。
  const normalizeForCompare = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = relative(normalizeForCompare(realRoot), normalizeForCompare(realTarget));

  if (rel.startsWith('..') || isAbsolute(rel)) throw new PathOutsideRootError(absoluteTarget);

  return realTarget;
}
