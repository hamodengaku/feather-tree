import { describe, expect, it } from 'vitest';
import type { FeatherTreeBridge } from '@feathertree/ipc';
import { AppState } from '../src/lib/appState.svelte.js';
import { FakeBridge, entry, installDocumentStub } from './fakeBridge.js';

installDocumentStub();

/**
 * renderer の状態機械を main 抜きで検証する。
 * Phase 5 の「変更一覧 → ステージ → コミット」の縦の流れと、
 * 設計上の制約（タブ切替で一覧を取り直さない・確認は main が強制する）を確認する。
 */
async function load(bridge: FeatherTreeBridge): Promise<AppState> {
  // bridge を注入するので window.ft も document も不要
  const app = new AppState(bridge);
  await app.initialize();
  return app;
}

async function boot(setup?: (bridge: FakeBridge) => void): Promise<{ app: AppState; bridge: FakeBridge }> {
  const bridge = new FakeBridge();
  setup?.(bridge);
  const app = await load(bridge.build());
  return { app, bridge };
}

describe('起動', () => {
  it('環境・設定・セッション一覧を取得して表示できる状態になる', async () => {
    const { app, bridge } = await boot((b) => {
      b.changes = [entry('a.txt'), entry('b.txt', { kind: 'untracked', worktree: '?' })];
      b.staged = [entry('c.txt', { staged: 'M' })];
    });

    expect(app.environment?.gitPath).toBe('C:/git/git.exe');
    expect(app.settings?.theme).toBe('classic-dark');
    expect(app.sessions).toHaveLength(2);
    expect(app.activeId).toBe('s1');
    expect(app.staged.total).toBe(1);
    expect(app.changes.total).toBe(2);
    expect(bridge.countOf('statusGetPage')).toBe(2);
  });

  it('git が無い環境では gitPath が null になる', async () => {
    const bridge = new FakeBridge();
    const app = await load({
      ...bridge.build(),
      appGetEnvironment: () =>
        Promise.resolve({
          ok: true as const,
          value: { gitPath: null, gitSource: null, gitVersion: null, warning: 'git が見つかりません' },
        }),
    });

    expect(app.environment?.gitPath).toBeNull();
    expect(app.environment?.warning).toContain('git が見つかりません');
  });
});

describe('ペイン幅', () => {
  it('center 幅の変更は left も含めて送る（浅いマージで消えないように）', async () => {
    const { app, bridge } = await boot();

    await app.setCenterPaneWidth(777);

    expect(bridge.lastArgsOf('settingsUpdate')).toEqual([{ paneWidths: { left: 260, center: 777 } }]);
    expect(app.settings?.paneWidths.center).toBe(777);
  });

  it('範囲外の値はクランプする', async () => {
    const { app } = await boot();

    await app.setCenterPaneWidth(10);
    expect(app.settings?.paneWidths.center).toBe(200);

    await app.setCenterPaneWidth(9999);
    expect(app.settings?.paneWidths.center).toBe(2000);
  });
});

describe('タブ切替', () => {
  it('一覧を取り直さない（キャッシュから復元する）', async () => {
    const { app, bridge } = await boot((b) => {
      b.changes = [entry('a.txt')];
    });

    const pagesAfterBoot = bridge.countOf('statusGetPage');

    await app.activate('s2');
    const pagesAfterFirstSwitch = bridge.countOf('statusGetPage');
    await app.activate('s1');

    // s2 は初回なので取得が走るが、s1 への復帰は取得ゼロ
    expect(pagesAfterFirstSwitch).toBeGreaterThan(pagesAfterBoot);
    expect(bridge.countOf('statusGetPage')).toBe(pagesAfterFirstSwitch);
    expect(app.activeId).toBe('s1');
  });

  it('同じタブを選び直しても IPC を呼ばない', async () => {
    const { app, bridge } = await boot();
    const before = bridge.calls.length;
    await app.activate('s1');
    expect(bridge.calls.length).toBe(before);
  });
});

describe('ステージングとコミット', () => {
  it('すべてステージは範囲指定 1 回で送る（パス配列を送らない）', async () => {
    const { app, bridge } = await boot((b) => {
      b.changes = Array.from({ length: 500 }, (_, i) => entry(`f${String(i)}.txt`));
    });

    await app.stage({ kind: 'filtered', filter: { group: 'changes' } });

    expect(bridge.countOf('stage')).toBe(1);
    const args = bridge.lastArgsOf('stage');
    expect(args?.[1]).toEqual({ kind: 'filtered', filter: { group: 'changes' } });
    // パス配列が IPC に乗っていないこと
    expect(JSON.stringify(args)).not.toContain('f499.txt');
  });

  it('コミットできる条件を正しく判定する', async () => {
    const { app } = await boot((b) => {
      b.staged = [entry('a.txt', { staged: 'M' })];
    });

    expect(app.canCommit).toBe(false);
    app.commitMessage = '   ';
    expect(app.canCommit).toBe(false);
    app.commitMessage = 'メッセージ';
    expect(app.canCommit).toBe(true);
  });

  it('ステージ済みが無ければコミットできない（amend を除く）', async () => {
    const { app } = await boot();
    app.commitMessage = 'メッセージ';
    expect(app.canCommit).toBe(false);
    app.amend = true;
    expect(app.canCommit).toBe(true);
  });

  it('コミット成功でメッセージがクリアされ一覧が更新される', async () => {
    const { app, bridge } = await boot((b) => {
      b.staged = [entry('a.txt', { staged: 'M' })];
    });
    app.commitMessage = 'コミットする';
    const pagesBefore = bridge.countOf('statusGetPage');

    await app.commit();

    expect(bridge.countOf('commit')).toBe(1);
    expect(app.commitMessage).toBe('');
    expect(app.amend).toBe(false);
    expect(bridge.countOf('statusGetPage')).toBeGreaterThan(pagesBefore);
  });

  it('ファイルを選ぶと diff を取得する', async () => {
    const { app, bridge } = await boot((b) => {
      b.changes = [entry('a.txt')];
    });

    await app.select({ path: 'a.txt', staged: false });

    expect(app.selected?.path).toBe('a.txt');
    expect(bridge.lastArgsOf('diffGet')).toEqual(['s1', 'a.txt', false]);
  });
});

describe('ダブルクリックでのステージ切替', () => {
  it('未ステージのファイルをステージへ移し、選択がそのまま追従する', async () => {
    const { app, bridge } = await boot((b) => {
      b.changes = [entry('a.txt')];
    });

    await app.toggleStage({ path: 'a.txt', staged: false });

    expect(bridge.countOf('stage')).toBe(1);
    expect(bridge.lastArgsOf('stage')?.[1]).toEqual({ kind: 'paths', paths: ['a.txt'] });
    expect(app.selected).toEqual({ path: 'a.txt', staged: true });
    expect(app.staged.entries.some((e) => e?.path === 'a.txt')).toBe(true);
  });

  it('ステージ済みのファイルを変更へ戻す', async () => {
    const { app, bridge } = await boot((b) => {
      b.staged = [entry('a.txt', { staged: 'M' })];
    });

    await app.toggleStage({ path: 'a.txt', staged: true });

    expect(bridge.countOf('unstage')).toBe(1);
    expect(app.selected).toEqual({ path: 'a.txt', staged: false });
    expect(app.changes.entries.some((e) => e?.path === 'a.txt')).toBe(true);
  });

  it('失敗した場合は selected が反転したまま残る（既知のトレードオフ）', async () => {
    const bridge = new FakeBridge();
    bridge.changes = [entry('a.txt')];
    const app = await load({
      ...bridge.build(),
      stage: () =>
        Promise.resolve({
          ok: false as const,
          error: { kind: 'git-failed' as const, message: '失敗しました' },
        }),
    });

    await app.toggleStage({ path: 'a.txt', staged: false });

    expect(app.selected).toEqual({ path: 'a.txt', staged: true });
    expect(app.error?.message).toBe('失敗しました');
  });
});

describe('破壊的操作の確認 (決定 16)', () => {
  it('main が拒否したら確認ダイアログの内容を保持する', async () => {
    const { app, bridge } = await boot((b) => {
      b.requireConfirmation = 'discard';
      b.changes = [entry('a.txt')];
    });

    await app.discard({ kind: 'paths', paths: ['a.txt'] });

    expect(app.pendingConfirmation).not.toBeNull();
    expect(app.pendingConfirmation?.confirmation.confirmLabel).toBe('実行');
    expect(app.error).toBeNull();
    expect(bridge.confirmedCalls).toEqual([]);
  });

  it('承認すると confirmed: true で再送する', async () => {
    const { app, bridge } = await boot((b) => {
      b.requireConfirmation = 'discard';
      b.changes = [entry('a.txt')];
    });

    await app.discard({ kind: 'paths', paths: ['a.txt'] });
    await app.acceptConfirmation();

    expect(bridge.confirmedCalls).toEqual(['discard']);
    expect(app.pendingConfirmation).toBeNull();
  });

  it('キャンセルすると再送しない', async () => {
    const { app, bridge } = await boot((b) => {
      b.requireConfirmation = 'deleteUntracked';
      b.changes = [entry('a.txt', { kind: 'untracked', worktree: '?' })];
    });

    await app.deleteUntracked({ kind: 'filtered', filter: { group: 'untracked' } });
    app.cancelConfirmation();

    expect(app.pendingConfirmation).toBeNull();
    expect(bridge.confirmedCalls).toEqual([]);
    expect(bridge.countOf('deleteUntracked')).toBe(1);
  });

  it('確認不要な操作では確認を出さない', async () => {
    const { app } = await boot((b) => {
      b.changes = [entry('a.txt')];
    });
    await app.stage({ kind: 'all' });
    expect(app.pendingConfirmation).toBeNull();
    expect(app.error).toBeNull();
  });
});

describe('エラー表示', () => {
  it('git の失敗は原文つきで保持する', async () => {
    const bridge = new FakeBridge();
    const app = await load({
      ...bridge.build(),
      stage: () =>
        Promise.resolve({
          ok: false as const,
          error: { kind: 'git-failed' as const, message: '失敗しました', detail: 'fatal: something' },
        }),
    });

    await app.stage({ kind: 'all' });

    expect(app.error?.message).toBe('失敗しました');
    expect(app.error?.detail).toBe('fatal: something');
    app.dismissError();
    expect(app.error).toBeNull();
  });
});

describe('main からの通知', () => {
  it('ウィンドウ復帰時の更新通知で一覧を取り直す', async () => {
    const { app, bridge } = await boot();
    const before = bridge.countOf('statusGetSummary');

    bridge.emitChanged(app.activeId ?? '');
    await new Promise((r) => setTimeout(r, 30));

    expect(bridge.countOf('statusGetSummary')).toBeGreaterThan(before);
  });

  it('別タブの通知は無視する', async () => {
    const { app, bridge } = await boot();
    const before = bridge.countOf('statusGetSummary');

    bridge.emitChanged('s2');
    await new Promise((r) => setTimeout(r, 30));

    expect(bridge.countOf('statusGetSummary')).toBe(before);
    expect(app.activeId).toBe('s1');
  });
});

describe('ウィンドウ復帰時の更新モード', () => {
  it('モードの変更を送信して設定に反映する', async () => {
    const { app, bridge } = await boot();

    await app.setRefocusUpdateMode('modal');

    expect(bridge.lastArgsOf('settingsUpdate')).toEqual([{ refocusUpdateMode: 'modal' }]);
    expect(app.settings?.refocusUpdateMode).toBe('modal');
  });

  it('modal モードの通知を受けて確認待ちになり、承諾すると手動更新経路を呼ぶ', async () => {
    const { app, bridge } = await boot();

    bridge.emitFocusPrompt(app.activeId ?? '');
    expect(app.focusRefreshPrompt).toEqual({ sessionId: 's1' });

    await app.acceptFocusRefreshPrompt();

    expect(app.focusRefreshPrompt).toBeNull();
    expect(bridge.countOf('sessionRefresh')).toBe(1);
  });

  it('しないを選ぶと手動更新を呼ばない', async () => {
    const { app, bridge } = await boot();

    bridge.emitFocusPrompt(app.activeId ?? '');
    app.dismissFocusRefreshPrompt();

    expect(app.focusRefreshPrompt).toBeNull();
    expect(bridge.countOf('sessionRefresh')).toBe(0);
  });

  it('別タブ宛の通知は無視する', async () => {
    const { app, bridge } = await boot();

    bridge.emitFocusPrompt('s2');

    expect(app.focusRefreshPrompt).toBeNull();
  });
});
