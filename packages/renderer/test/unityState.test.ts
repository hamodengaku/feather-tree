import { describe, expect, it } from 'vitest';
import type { UnityNodeDetailDto } from '@feathertree/ipc';
import { AppState } from '../src/lib/appState.svelte.js';
import { TabActivity } from '../src/lib/tabActivity.js';
import { FakeBridge, entry, installDocumentStub } from './fakeBridge.js';

installDocumentStub();

/*
 * Unity モードの状態機械（Phase 12 M5 / M6）。
 *
 * 見るのは renderer の責務だけ——
 *   - モードに入るまで unity の IPC を 1 度も呼ばない
 *   - 読み込み中に他の操作をされたら**古い応答を捨てる**（要件 12）
 *   - ステージは既存の stageHunks / unstageHunks にそのまま流れる（新しい口を増やさない）
 */

async function boot(
  setup?: (bridge: FakeBridge) => void,
): Promise<{ app: AppState; bridge: FakeBridge }> {
  const bridge = new FakeBridge();
  bridge.changes = [entry('Assets/Player.prefab'), entry('Assets/Other.prefab')];
  setup?.(bridge);
  const app = new AppState(bridge.build(), {
    tabActivity: new TabActivity({ delayMs: 0, minMs: 0, graceMs: 0 }),
  });
  await app.initialize();
  return { app, bridge };
}

function detail(over: Partial<UnityNodeDetailDto> = {}): UnityNodeDetailDto {
  return {
    nodeId: '101',
    rows: [
      {
        key: 'm_LocalScale.x',
        before: '1',
        after: '2.5',
        state: 'changed',
        selection: [{ index: 0, header: '@@ -1,3 +1,3 @@', lineCount: 3, lines: [1, 2] }],
        alsoStages: 0,
      },
      {
        key: 'm_LocalScale.y',
        before: '1',
        after: '1',
        state: 'same',
        selection: null,
        alsoStages: 0,
      },
    ],
    selection: [{ index: 0, header: '@@ -1,3 +1,3 @@', lineCount: 3, lines: [1, 2] }],
    ...over,
  };
}

describe('モードに入るまで git を動かさない', () => {
  it('差分モードでファイルを選んでも unityGetView は呼ばれない', async () => {
    const { app, bridge } = await boot();
    await app.select({ path: 'Assets/Player.prefab', staged: false });
    expect(bridge.calls.some((c) => c.name === 'unityGetView')).toBe(false);
    expect(bridge.calls.some((c) => c.name === 'diffGet')).toBe(true);
  });

  it('Unity モードで選ぶと unityGetView になり、diffGet は呼ばれない', async () => {
    const { app, bridge } = await boot((b) => {
      b.unityNodeDetails.set('101', detail());
    });
    await app.enterUnityMode();
    bridge.calls.length = 0;

    await app.select({ path: 'Assets/Player.prefab', staged: false });
    expect(bridge.calls.some((c) => c.name === 'unityGetView')).toBe(true);
    expect(bridge.calls.some((c) => c.name === 'diffGet')).toBe(false);
  });

  it('モードに入るとブランチペインが畳まれる（設定の書き込みは 1 回）', async () => {
    const { app, bridge } = await boot();
    bridge.calls.length = 0;
    await app.enterUnityMode();

    expect(app.viewMode).toBe('unity');
    expect(app.settings?.branchPaneCollapsed).toBe(true);
    expect(bridge.calls.filter((c) => c.name === 'settingsUpdate')).toHaveLength(1);
  });

  it('モードを抜けても畳んだままにする（勝手に戻さない）', async () => {
    const { app } = await boot();
    await app.enterUnityMode();
    await app.setViewMode('diff');
    expect(app.settings?.branchPaneCollapsed).toBe(true);
  });
});

describe('ビューと表の取得', () => {
  it('ヒエラルキーを取ると、最初の変更ノードが選ばれて表も来る', async () => {
    const { app, bridge } = await boot((b) => {
      b.unityNodeDetails.set('100', detail({ nodeId: '100' }));
    });
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Player.prefab', staged: false });

    // FakeBridge の既定は Player(changed) → Transform(changed)
    expect(app.unitySelectedNode).toBe('100');
    expect(app.unityNode?.nodeId).toBe('100');
    expect(bridge.calls.filter((c) => c.name === 'unityGetNode')).toHaveLength(1);
  });

  it('変更のある節までの経路が開いた状態で始まる（要件 7）', async () => {
    const { app } = await boot();
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Player.prefab', staged: false });
    // Player は hasChangedDescendant なので開く。Transform は子が無いので開かない
    expect([...app.unityExpanded]).toEqual(['100']);
  });

  it('同じファイルを選び直しても取り直さない（ちらつかせない）', async () => {
    const { app, bridge } = await boot();
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Player.prefab', staged: false });
    const before = bridge.calls.filter((c) => c.name === 'unityGetView').length;

    await app.select({ path: 'Assets/Player.prefab', staged: false });
    expect(bridge.calls.filter((c) => c.name === 'unityGetView')).toHaveLength(before);
  });

  it('別のノードを選ぶと表だけ取り直す', async () => {
    const { app, bridge } = await boot((b) => {
      b.unityNodeDetails.set('101', detail());
    });
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Player.prefab', staged: false });
    bridge.calls.length = 0;

    await app.selectUnityNode('101');
    expect(app.unityNode?.nodeId).toBe('101');
    expect(bridge.calls.filter((c) => c.name === 'unityGetView')).toHaveLength(0);
    expect(bridge.calls.filter((c) => c.name === 'unityGetNode')).toHaveLength(1);
  });

  it('展開の切り替えは IPC を増やさない', async () => {
    const { app, bridge } = await boot();
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Player.prefab', staged: false });
    const before = bridge.calls.length;

    app.toggleUnityNode('100');
    expect(app.unityExpanded.has('100')).toBe(false);
    app.toggleUnityNode('100');
    expect(app.unityExpanded.has('100')).toBe(true);
    expect(bridge.calls).toHaveLength(before);
  });
});

describe('読み込み中の破棄（要件 12）', () => {
  it('読み込み中に別のファイルを選んだら、古い応答を捨てる', async () => {
    const { app } = await boot((b) => {
      b.diffDelayMs = 20;
    });
    await app.enterUnityMode();

    // 1 件目は待たずに 2 件目を選ぶ
    const first = app.select({ path: 'Assets/Player.prefab', staged: false });
    const second = app.select({ path: 'Assets/Other.prefab', staged: false });
    await Promise.all([first, second]);

    // 後から来た 1 件目の応答で上書きされていない
    expect(app.unityView?.path).toBe('Assets/Other.prefab');
    expect(app.unityLoading).toBe(false);
  });

  it('ビューを取り直すと、前のノードの選択と表は捨てる', async () => {
    const { app, bridge } = await boot((b) => {
      b.unityNodeDetails.set('100', detail({ nodeId: '100' }));
    });
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Player.prefab', staged: false });
    expect(app.unityNode).not.toBeNull();

    // 次のファイルには表が無い状態にしておく
    bridge.unityNodeDetails.clear();
    await app.loadUnity({ path: 'Assets/Other.prefab', staged: false });
    expect(app.unityNode).toBeNull();
  });

  it('モードを離れたら持ち物を手放す', async () => {
    const { app } = await boot();
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Player.prefab', staged: false });
    expect(app.unityView).not.toBeNull();

    app.releaseUnity();
    expect(app.unityView).toBeNull();
    expect(app.unitySelectedNode).toBeNull();
    expect(app.unityExpanded.size).toBe(0);
  });
});

describe('ステージ（要件 13）', () => {
  it('1 パラメータだけステージは、既存の stageHunks にそのまま流れる', async () => {
    const { app, bridge } = await boot((b) => {
      b.unityNodeDetails.set('100', detail({ nodeId: '100' }));
    });
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Player.prefab', staged: false });

    const row = app.unityNode?.rows.find((r) => r.key === 'm_LocalScale.x');
    bridge.calls.length = 0;
    await app.applyUnitySelection(row?.selection ?? null);

    const staged = bridge.calls.filter((c) => c.name === 'stageHunks');
    expect(staged).toHaveLength(1);
    expect(staged[0]?.args[1]).toMatchObject({
      path: 'Assets/Player.prefab',
      hunks: [{ index: 0, lines: [1, 2] }],
    });
    // 新しいステージ用のチャネルは増やしていない
    expect(bridge.calls.some((c) => c.name.startsWith('unityStage'))).toBe(false);
  });

  it('ステージした後はビューを取り直す（座標が古くならないように）', async () => {
    const { app, bridge } = await boot((b) => {
      b.unityNodeDetails.set('100', detail({ nodeId: '100' }));
    });
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Player.prefab', staged: false });

    const row = app.unityNode?.rows.find((r) => r.key === 'm_LocalScale.x');
    bridge.calls.length = 0;
    await app.applyUnitySelection(row?.selection ?? null);

    expect(bridge.calls.filter((c) => c.name === 'unityGetView')).toHaveLength(1);
  });

  it('ステージの取り直しで diff:get を呼ばない（見えていないもののために git を起動しない）', async () => {
    const { app, bridge } = await boot((b) => {
      b.unityNodeDetails.set('100', detail({ nodeId: '100' }));
    });
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Player.prefab', staged: false });

    const row = app.unityNode?.rows.find((r) => r.key === 'm_LocalScale.x');
    bridge.calls.length = 0;
    await app.applyUnitySelection(row?.selection ?? null);

    // 取り直しは unityGetView に一本化されていて、diff は 1 度も取らない
    expect(bridge.calls.filter((c) => c.name === 'diffGet')).toHaveLength(0);
    expect(bridge.calls.filter((c) => c.name === 'unityGetView')).toHaveLength(1);
  });

  it('更新（reloadActive）でも diff:get を呼ばない', async () => {
    const { app, bridge } = await boot();
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Player.prefab', staged: false });
    bridge.calls.length = 0;

    await app.reloadActive();
    expect(bridge.calls.filter((c) => c.name === 'diffGet')).toHaveLength(0);
    expect(bridge.calls.filter((c) => c.name === 'unityGetView')).toHaveLength(1);
  });

  it('ステージ済みを見ているときはアンステージになる', async () => {
    const { app, bridge } = await boot((b) => {
      b.staged = [entry('Assets/Player.prefab', { staged: 'M', worktree: '.' })];
      b.unityNodeDetails.set('100', detail({ nodeId: '100' }));
    });
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Player.prefab', staged: true });

    const row = app.unityNode?.rows.find((r) => r.key === 'm_LocalScale.x');
    bridge.calls.length = 0;
    await app.applyUnitySelection(row?.selection ?? null);

    expect(bridge.calls.filter((c) => c.name === 'unstageHunks')).toHaveLength(1);
    expect(bridge.calls.filter((c) => c.name === 'stageHunks')).toHaveLength(0);
  });

  it('未変更行には座標が無いので、押しても何も起きない', async () => {
    const { app, bridge } = await boot((b) => {
      b.unityNodeDetails.set('100', detail({ nodeId: '100' }));
    });
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Player.prefab', staged: false });

    const same = app.unityNode?.rows.find((r) => r.key === 'm_LocalScale.y');
    expect(same?.selection).toBeNull();
    bridge.calls.length = 0;
    await app.applyUnitySelection(same?.selection ?? null);
    expect(bridge.calls).toHaveLength(0);
  });
});

describe('展開できないファイル', () => {
  it('Prefab でなければ案内だけを持つ（通常の diff へは倒さない）', async () => {
    const { app, bridge } = await boot((b) => {
      b.unityFormat = 'not-prefab';
      b.unityStageable = false;
    });
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Script.cs', staged: false });

    expect(app.unityView?.format).toBe('not-prefab');
    expect(app.unityView?.nodes).toHaveLength(0);
    expect(bridge.calls.some((c) => c.name === 'diffGet')).toBe(false);
  });

  it('バイナリなら表もノードも取りに行かない', async () => {
    const { app, bridge } = await boot((b) => {
      b.unityFormat = 'binary';
      b.unityStageable = false;
      b.unityRefusal = 'binary';
    });
    await app.enterUnityMode();
    await app.select({ path: 'Assets/Bin.prefab', staged: false });

    expect(app.unityView?.format).toBe('binary');
    expect(bridge.calls.some((c) => c.name === 'unityGetNode')).toBe(false);
  });
});
