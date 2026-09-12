// electron-builder の afterPack フック。
// パッケージ後・成果物（portable exe / zip）の作成前に呼ばれるので、
// ここで消したファイルはどの成果物にも含まれない。
//
// なぜ files ではなくここなのか:
//   electron-builder の `files` は **app 側（resources/app）にしか効かない**。
//   Chromium が持ち込む DLL は Electron 本体の配布物なので、`files` では 1 バイトも削れない。
//
// CLAUDE.md: rmSync はこの環境でプロセスを即死させるため、必ず node:fs/promises の rm を使う。
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 削除する Chromium のファイル（決定 5）。
 *
 * どちらも WebGPU（Chromium の実装は Dawn）専用の経路にしか使われない。
 *   dxcompiler.dll — DXC。WGSL -> HLSL -> DXIL のコンパイラ。
 *                    ファイル自身が製品名に "Google Dawn Custom Build" と名乗っている。
 *                    LLVM/Clang のフォークなので約 25MB ある。
 *   dxil.dll       — Microsoft の DXIL 検証・署名器（"Out Of Band" 再配布物）。
 *                    DXC が出した DXIL はこれで署名されないと GPU ドライバが受け付けない。
 *
 * FeatherTree の画面は DOM + CSS + インライン SVG だけで WebGPU を使わない。
 * ページが WebGPU アダプタを要求しない限りこの 2 つは読み込まれないので、外しても
 * 通常の描画には影響しない。**代償は配布物で WebGPU が使えなくなること。**
 * 将来 WebGPU を使う機能を入れるなら、まずここを戻すこと。
 *
 * 残すもの（消してはいけない）:
 *   d3dcompiler_47.dll  — FXC。ANGLE / D3D11 経由の**画面合成が常用する**
 *   vk_swiftshader.dll  — GPU が使えない環境のソフトウェア描画。外すとその環境で描画できない
 *   vulkan-1.dll        — 同上（Vulkan ローダ）
 */
const REMOVE_ON_WIN32 = ['dxcompiler.dll', 'dxil.dll'];

export default async function afterPack(context) {
  // 将来 mac / Linux を足したときに巻き込まれないよう、Windows だけに限定する
  if (context.electronPlatformName !== 'win32') return;

  let removedBytes = 0;
  const removed = [];

  for (const name of REMOVE_ON_WIN32) {
    const target = join(context.appOutDir, name);
    try {
      const info = await stat(target);
      await rm(target, { force: true });
      removedBytes += info.size;
      removed.push(name);
    } catch {
      // 既に無い（Electron 側が同梱をやめた等）。削除が目的なので失敗扱いにしない
    }
  }

  const mb = (removedBytes / 1024 / 1024).toFixed(1);
  console.log(
    removed.length === 0
      ? '[afterPack] 削除対象の DLL は見つかりませんでした（Electron 側の同梱が変わった可能性）'
      : `[afterPack] WebGPU 用 DLL を削除: ${removed.join(', ')}（${mb} MB）`,
  );
}
