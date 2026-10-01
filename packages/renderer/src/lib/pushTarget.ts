import type { BranchDto } from '@feathertree/ipc';

export interface PushTarget {
  readonly remote: string;
  readonly branch: string;
  /** 真なら対応表 #25（上流を張りながらプッシュ）。 */
  readonly setUpstream: boolean;
}

/**
 * 「コミット&プッシュ」の行き先を、ダイアログを出さずに決められるなら決める。
 *
 * - 上流が `<remote>/<同名>` ならそこへ（#24）
 * - 上流が無ければ origin、無ければ唯一のリモートへ上流を張って送る（#25。PushDialog の既定と同じ）
 * - それ以外（detached、上流の枝名が違う、リモートが決められない）は null。
 *   呼び出し側はプッシュダイアログを開いて利用者に選ばせる
 */
export function commitPushTarget(
  current: string | null,
  branches: readonly BranchDto[],
  remotes: readonly string[],
): PushTarget | null {
  if (current === null) return null;
  const local = branches.find((b) => !b.isRemote && b.shortName === current);
  const upstream = local?.upstream ?? null;

  if (upstream !== null) {
    // リモート名に '/' を含みうるので、先頭の '/' で切らずに既知のリモート名と突き合わせる
    const remote = remotes.find((r) => upstream === r + '/' + current);
    return remote === undefined ? null : { remote, branch: current, setUpstream: false };
  }

  const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
  return remote === undefined ? null : { remote, branch: current, setUpstream: true };
}
