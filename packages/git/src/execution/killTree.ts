import { spawn, type ChildProcess } from 'node:child_process';

/**
 * git のプロセスツリーごと終了させる。
 *
 * child.kill() だけでは LFS のフィルタや credential helper が孫プロセスとして
 * 残ることがあるため、猶予時間を過ぎたら Windows では taskkill /T /F で刈り取る。
 * これはキャンセル操作の応答性に直結するので必須（docs/02-git-command-map.md キャンセル節）。
 *
 * Windows 以外では、spawnGit が git をプロセスグループのリーダーとして起動している
 * （`detached: true`）ので、グループ宛てのシグナルで孫（git-remote-https / git-lfs / ssh）
 * ごと落とす。git 本体だけに送ると孫が残り、キャンセルしたクローンの転送が裏で続く。
 */
export async function killTree(child: ChildProcess, graceMs = 500): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') child.kill();
  else signalGroup(child, 'SIGTERM');

  const exited = await waitForExit(child, graceMs);
  if (exited) return;

  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    await forceKillWindows(pid);
  } else {
    signalGroup(child, 'SIGKILL');
  }
}

/**
 * プロセスグループ（負の pid）へシグナルを送る。
 *
 * グループが無い（リーダーとして起動されていない・既に消えた）場合は例外になるので、
 * そのときは本体だけに送る従来の動きへ落とす。
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // 下の child.kill に任せる
    }
  }
  child.kill(signal);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    function onExit(): void {
      clearTimeout(timer);
      resolve(true);
    }
    child.once('exit', onExit);
  });
}

function forceKillWindows(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('close', () => resolve());
    killer.on('error', () => resolve());
  });
}
