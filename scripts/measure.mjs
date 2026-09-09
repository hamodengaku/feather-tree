// Phase 0 / Phase 10 の実測: 配布物のサイズ・起動時間・メモリ。
//
// 既定では release/win-unpacked を計測する（zip 配布版と同等）。
// portable exe は起動時に %TEMP% へ約 266MB 展開するため、
// CLAUDE.md 規約 2 に触れる。計測したい場合のみ --portable を明示する。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
// rmSync はこの環境でプロセスを即死させるため使わない（CLAUDE.md 参照）
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const out = (s) => process.stdout.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = resolve(import.meta.dirname, '..');
const releaseDir = resolve(root, 'release');
const usePortable = process.argv.includes('--portable');

function dirSizeMb(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += statSync(p).size;
    }
  };
  walk(dir);
  return total / 1024 / 1024;
}

function runTasklist(image) {
  return new Promise((res) => {
    const p = spawn('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH']);
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.on('close', () => res(buf));
    p.on('error', () => res(''));
  });
}

function parseProcs(csv, image) {
  return csv
    .split(/\r?\n/)
    .filter((l) => l.includes(image))
    .map((l) => {
      const cols = l.split('","').map((c) => c.replace(/^"|"$/g, ''));
      return { pid: Number(cols[1]), kb: Number((cols[4] ?? '0').replace(/[^0-9]/g, '')) };
    })
    .filter((p) => Number.isFinite(p.pid) && p.pid > 0);
}

async function killAll(image) {
  await new Promise((res) => {
    const p = spawn('taskkill', ['/IM', image, '/T', '/F'], { stdio: 'ignore' });
    p.on('close', res);
    p.on('error', res);
  });
}

async function main() {
  out('== 配布物のサイズ ==');
  for (const f of readdirSync(releaseDir)) {
    if (f.endsWith('.exe') || f.endsWith('.zip')) {
      out(`  ${f.padEnd(38)} ${(statSync(resolve(releaseDir, f)).size / 1024 / 1024).toFixed(1)} MB`);
    }
  }
  const unpacked = resolve(releaseDir, 'win-unpacked');
  if (existsSync(unpacked)) out(`  win-unpacked (展開後)${' '.repeat(18)} ${dirSizeMb(unpacked).toFixed(1)} MB`);

  const exe = usePortable
    ? resolve(releaseDir, readdirSync(releaseDir).find((f) => f.endsWith('portable.exe')) ?? '')
    : resolve(unpacked, 'FeatherTree.exe');
  if (!existsSync(exe)) {
    process.stderr.write(`計測対象が見つかりません: ${exe}\n先に npm run dist を実行してください。\n`);
    process.exit(1);
  }

  const dataDir = usePortable
    ? resolve(releaseDir, 'FeatherTree-data')
    : resolve(unpacked, 'FeatherTree-data');
  const metricsFile = resolve(dataDir, 'startup-metrics.json');
  await rm(metricsFile, { force: true });

  out('');
  out(`== 起動計測 (${usePortable ? 'portable exe' : 'win-unpacked'}) ==`);
  if (usePortable) out('  ※ portable は %TEMP% へ展開します（CLAUDE.md 規約 2 に触れる点に注意）');

  const wallStart = Date.now();
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();

  let metrics = null;
  for (let i = 0; i < 300; i += 1) {
    if (existsSync(metricsFile)) {
      await sleep(150);
      try {
        metrics = JSON.parse(readFileSync(metricsFile, 'utf8'));
        break;
      } catch {
        // 書き込み途中。次のループで読み直す
      }
    }
    await sleep(100);
  }
  const wallMs = Date.now() - wallStart;

  if (!metrics) {
    out('  起動計測: 失敗（30 秒以内に startup-metrics.json が現れませんでした）');
  } else {
    out(`  プロセス起動 -> app.ready      : ${metrics.appReadyMs} ms`);
    out(`  プロセス起動 -> ウィンドウ表示 : ${metrics.readyToShowMs} ms`);
    out(`  実測待ち時間（参考）           : ${wallMs} ms`);
  }

  await sleep(2500);
  const procs = parseProcs(await runTasklist('FeatherTree.exe'), 'FeatherTree.exe');
  const totalMb = procs.reduce((a, p) => a + p.kb, 0) / 1024;
  out(`  メモリ合計                     : ${totalMb.toFixed(0)} MB (${procs.length} プロセス)`);

  await killAll('FeatherTree.exe');
  if (usePortable) await killAll('FeatherTree-0.0.0-portable.exe');
  out('');
  out('計測完了。アプリは終了させました。');
}

main().catch((e) => {
  process.stderr.write(`計測に失敗しました: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
