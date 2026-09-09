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
