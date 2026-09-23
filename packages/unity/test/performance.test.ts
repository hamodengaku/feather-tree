import { describe, expect, it } from 'vitest';
import { parseUnityFile } from '../src/index.js';

/*
 * Phase 12 M1 の受け入れ条件: 巨大なシーンを**2 秒以内・ヒープ増分がファイルサイズの 3 倍以内**で
 * パースできること（docs/03-implementation-plan.md の F-1）。
 *
 * 決定 32 でサイズ上限を設けないと決めたので、100MB 級が来ても落ちない形かどうかを
 * ここで押さえる。満たせないなら設計をやり直す、という位置づけの計測。
 *
 * 通常の `npm test` では走らせない（数十秒かかる）。`npm run test:unity-perf` で明示実行する。
 * git 層の performance.test.ts と同じ作法。
 */

/**
 * このパッケージは `tsconfig.json` の `types: []` で **Node の型を入れていない**
 * （純関数であることの担保。決定 32）。計測にだけ `process` が要るので、
 * ここでグローバルから取り出す。`src` 側からは決して触らない。
 */
interface NodeProcessShim {
  readonly env?: Record<string, string | undefined>;
  memoryUsage?: () => { heapUsed: number };
  hrtime?: { bigint: () => bigint };
}
const proc = (globalThis as { process?: NodeProcessShim }).process;
const targetMb = Number.parseInt(proc?.env?.['FT_UNITY_PERF_MB'] ?? '0', 10);

const LF = String.fromCharCode(10);

/**
 * 実物の `.unity` に近い形の合成シーンを作る。
 *
 * 1 GameObject あたり GameObject / Transform / MeshRenderer の 3 ドキュメントで、
 * 実物のシーンと同じく「短い行が延々と続く」形になる。
 */
function buildScene(targetBytes: number): string {
  const parts: string[] = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:'];
  let size = 40;
  let id = 1000000;

  while (size < targetBytes) {
    const go = id;
    const tr = id + 1;
    const mr = id + 2;
    id += 3;

    const block = [
      '--- !u!1 &' + String(go),
      'GameObject:',
      '  m_ObjectHideFlags: 0',
      '  m_CorrespondingSourceObject: {fileID: 0}',
      '  m_PrefabInstance: {fileID: 0}',
      '  m_PrefabAsset: {fileID: 0}',
      '  serializedVersion: 6',
      '  m_Component:',
      '  - component: {fileID: ' + String(tr) + '}',
      '  - component: {fileID: ' + String(mr) + '}',
      '  m_Layer: 0',
      '  m_Name: Node' + String(go),
      '  m_TagString: Untagged',
      '  m_Icon: {fileID: 0}',
      '  m_NavMeshLayer: 0',
      '  m_StaticEditorFlags: 0',
      '  m_IsActive: 1',
      '--- !u!4 &' + String(tr),
      'Transform:',
      '  m_ObjectHideFlags: 0',
      '  m_CorrespondingSourceObject: {fileID: 0}',
      '  m_GameObject: {fileID: ' + String(go) + '}',
      '  serializedVersion: 2',
      '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
      '  m_LocalPosition: {x: 0, y: 0, z: 0}',
      '  m_LocalScale: {x: 1, y: 1, z: 1}',
      '  m_ConstrainProportionsScale: 0',
      '  m_Children: []',
      '  m_Father: {fileID: 0}',
      '  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}',
      '--- !u!23 &' + String(mr),
      'MeshRenderer:',
      '  m_ObjectHideFlags: 0',
      '  m_GameObject: {fileID: ' + String(go) + '}',
      '  m_Enabled: 1',
      '  m_CastShadows: 1',
      '  m_ReceiveShadows: 1',
      '  m_Materials:',
      '  - {fileID: 2100000, guid: 0000000000000000f000000000000000, type: 2}',
      '  m_StaticBatchInfo:',
      '    firstSubMesh: 0',
      '    subMeshCount: 0',
      '',
    ].join(LF);
    parts.push(block);
    size += block.length + 1;
  }
  return parts.join(LF);
}

describe.runIf(targetMb > 0)('巨大シーンのパース', () => {
  it('2 秒以内・ヒープ増分がファイルサイズの 3 倍以内で読める', () => {
    const text = buildScene(targetMb * 1024 * 1024);
    const bytes = text.length;

    const before = proc?.memoryUsage?.().heapUsed ?? 0;
    const started = Date.now();
    const file = parseUnityFile(text);
    const elapsedMs = Date.now() - started;
    const after = proc?.memoryUsage?.().heapUsed ?? 0;
    const heapDelta = after - before;

    // 値は必ず出力に残す（Phase 12 の DoD で実測を記録するため）
    console.log(
      [
        'size=' + (bytes / 1024 / 1024).toFixed(1) + 'MB',
        'lines=' + String(file.lineCount),
        'documents=' + String(file.documents.length),
        'parseMs=' + String(elapsedMs),
        'heapDeltaMB=' + (heapDelta / 1024 / 1024).toFixed(1),
        'heapRatio=' + (heapDelta / bytes).toFixed(2),
      ].join(' '),
    );

    expect(file.documents.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(2000);
    expect(heapDelta).toBeLessThan(bytes * 3);
  });
});
