import { spawn, type ChildProcess } from 'node:child_process';

/**
 * git のプロセスツリーごと終了させる。
 *
 * child.kill() だけでは LFS のフィルタや credential helper が孫プロセスとして
 * 残ることがあるため、猶予時間を過ぎたら Windows では taskkill /T /F で刈り取る。
 * これはキャンセル操作の応答性に直結するので必須（docs/02-git-command-map.md キャンセル節）。
 */
export async function killTree(child: ChildProcess, graceMs = 500): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill();

  const exited = await waitForExit(child, graceMs);
  if (exited) return;

  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    await forceKillWindows(pid);
  } else {
    child.kill('SIGKILL');
  }
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
