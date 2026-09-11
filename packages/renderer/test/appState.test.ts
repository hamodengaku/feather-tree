import { describe, expect, it } from 'vitest';
import type { FeatherTreeBridge } from '@feathertree/ipc';
import { AppState } from '../src/lib/appState.svelte.js';
import { FakeBridge, branch, entry, installDocumentStub } from './fakeBridge.js';

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
  it('center/diff 比率の変更は paneWidths の他フィールドも含めて送る（浅いマージで消えないように）', async () => {
    const { app, bridge } = await boot();

    await app.setCenterRatio(0.6);

    expect(bridge.lastArgsOf('settingsUpdate')).toEqual([
      { paneWidths: { left: 260, center: 420, centerRatio: 0.6 } },
    ]);
    expect(app.settings?.paneWidths.centerRatio).toBe(0.6);
  });

  it('範囲外の値はクランプする', async () => {
    const { app } = await boot();

    await app.setCenterRatio(0);
    expect(app.settings?.paneWidths.centerRatio).toBe(0.1);

    await app.setCenterRatio(1);
    expect(app.settings?.paneWidths.centerRatio).toBe(0.9);
  });

  it('ブランチペイン幅の変更は paneWidths の他フィールドも含めて送る（浅いマージで消えないように）', async () => {
    const { app, bridge } = await boot();

    await app.setLeftWidth(300);

    expect(bridge.lastArgsOf('settingsUpdate')).toEqual([
      { paneWidths: { left: 300, center: 420, centerRatio: null } },
    ]);
    expect(app.settings?.paneWidths.left).toBe(300);
  });

  it('ブランチペイン幅は範囲外の値をクランプする', async () => {
    const { app } = await boot();

    await app.setLeftWidth(1);
    expect(app.settings?.paneWidths.left).toBe(120);

    await app.setLeftWidth(99999);
    expect(app.settings?.paneWidths.left).toBe(1200);
  });

  it('ブランチペインのローカル高さを変更・永続化できる', async () => {
    const { app, bridge } = await boot();

    await app.setBranchLocalHeight(250);

    expect(bridge.lastArgsOf('settingsUpdate')).toEqual([{ branchLocalHeight: 250 }]);
    expect(app.settings?.branchLocalHeight).toBe(250);
  });

  it('ブランチペインのローカル高さは範囲外の値をクランプする', async () => {
    const { app } = await boot();

    await app.setBranchLocalHeight(1);
    expect(app.settings?.branchLocalHeight).toBe(80);

    await app.setBranchLocalHeight(99999);
    expect(app.settings?.branchLocalHeight).toBe(4000);
  });

  it('ブランチペインの折り畳み状態を変更・永続化できる', async () => {
    const { app, bridge } = await boot();

    await app.setBranchPaneCollapsed(true);

    expect(bridge.lastArgsOf('settingsUpdate')).toEqual([{ branchPaneCollapsed: true }]);
    expect(app.settings?.branchPaneCollapsed).toBe(true);

    await app.setBranchPaneCollapsed(false);
    expect(app.settings?.branchPaneCollapsed).toBe(false);
  });

  it('実行ログパネルの高さを変更・永続化できる', async () => {
    const { app, bridge } = await boot();

    await app.setCommandLogHeight(300);

    expect(bridge.lastArgsOf('settingsUpdate')).toEqual([{ commandLogHeight: 300 }]);
    expect(app.settings?.commandLogHeight).toBe(300);
  });

  it('実行ログパネルの高さは範囲外の値をクランプする', async () => {
    const { app } = await boot();

    await app.setCommandLogHeight(1);
    expect(app.settings?.commandLogHeight).toBe(120);

    await app.setCommandLogHeight(99999);
    expect(app.settings?.commandLogHeight).toBe(800);
  });

  it('ステージ済み/変更の分割高さを変更・永続化できる', async () => {
    const { app, bridge } = await boot();

    await app.setStagedHeight(250);

    expect(bridge.lastArgsOf('settingsUpdate')).toEqual([{ stagedHeight: 250 }]);
    expect(app.settings?.stagedHeight).toBe(250);
  });

  it('ステージ済み/変更の分割高さは範囲外の値をクランプする', async () => {
    const { app } = await boot();

    await app.setStagedHeight(1);
    expect(app.settings?.stagedHeight).toBe(80);

    await app.setStagedHeight(99999);
    expect(app.settings?.stagedHeight).toBe(4000);
  });
});

describe('タブの並び替え', () => {
  it('ドラッグ中はローカルの表示順だけを更新し、IPC は呼ばない', async () => {
    const { app, bridge } = await boot();
    const before = bridge.calls.length;

    app.reorderTabs(['s2', 's1']);

    expect(app.sessions.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(bridge.calls.length).toBe(before);
  });

  it('確定時に新しい順序を IPC で送る', async () => {
    const { app, bridge } = await boot();

    app.reorderTabs(['s2', 's1']);
    await app.commitTabOrder();

    expect(bridge.lastArgsOf('sessionReorder')).toEqual([['s2', 's1']]);
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

describe('更新（リロード）の対象', () => {
  it('更新ボタンは表示物をすべて取り直す（非アクティブ中の外部操作を拾うため）', async () => {
    const { app, bridge } = await boot((b) => {
      b.branches = [branch('main', { isHead: true })];
    });
    expect(app.branches.map((b) => b.shortName)).toEqual(['main']);

    // 非アクティブの間に、ターミナル等でブランチが増えた状況
    bridge.branches = [branch('main', { isHead: true }), branch('obana/topic')];
    const summariesBefore = bridge.countOf('statusGetSummary');
    const branchesBefore = bridge.countOf('branchList');

    await app.refresh('full');

    expect(bridge.lastArgsOf('sessionRefresh')).toEqual(['s1', 'full']);
    expect(bridge.countOf('statusGetSummary')).toBeGreaterThan(summariesBefore);
    expect(bridge.countOf('branchList')).toBeGreaterThan(branchesBefore);
    expect(app.branches.map((b) => b.shortName)).toEqual(['main', 'obana/topic']);
  });

  it('更新してもユーザーの入力は消さない', async () => {
    const { app } = await boot((b) => {
      b.staged = [entry('a.txt', { staged: 'M' })];
    });
    app.commitMessage = '書きかけのメッセージ';
    app.amend = true;
    app.createBranchOpen = true;

    await app.refresh('full');

    expect(app.commitMessage).toBe('書きかけのメッセージ');
    expect(app.amend).toBe(true);
    expect(app.createBranchOpen).toBe(true);
  });

  it('書き込み操作の後はブランチ一覧を取り直さない（main が取り直していないため）', async () => {
    const { app, bridge } = await boot((b) => {
      b.changes = [entry('a.txt')];
    });
    const before = bridge.countOf('branchList');

    await app.stage({ kind: 'paths', paths: ['a.txt'] });

    expect(bridge.countOf('branchList')).toBe(before);
  });

  it('タブを戻したときはキャッシュから復元し、取りに行かない', async () => {
    const { app, bridge } = await boot((b) => {
      b.branches = [branch('main', { isHead: true })];
    });

    await app.activate('s2');
    const afterFirstSwitch = bridge.countOf('branchList');
    await app.activate('s1');

    expect(bridge.countOf('branchList')).toBe(afterFirstSwitch);
    expect(app.branches.map((b) => b.shortName)).toEqual(['main']);
  });
});

describe('ブランチ操作', () => {
  it('ブランチ切替は確認なしで即実行し、一覧を更新する', async () => {
    const { app, bridge } = await boot();
    const pagesBefore = bridge.countOf('statusGetSummary');

    await app.switchBranch('feature');

    expect(bridge.lastArgsOf('branchSwitch')).toEqual(['s1', 'feature']);
    expect(bridge.countOf('statusGetSummary')).toBeGreaterThan(pagesBefore);
    expect(app.error).toBeNull();
  });

  it('ブランチ作成に成功するとダイアログを閉じる', async () => {
    const { app, bridge } = await boot();
    app.openCreateBranch();

    await app.createBranch('obana/topic', 'main', () => app.closeCreateBranch());

    expect(bridge.lastArgsOf('branchCreate')).toEqual(['s1', { name: 'obana/topic', startPoint: 'main' }]);
    expect(app.createBranchOpen).toBe(false);
  });

  it('ブランチ作成が失敗したらダイアログを閉じずエラーを保持する', async () => {
    const bridge = new FakeBridge();
    const failing: FeatherTreeBridge = {
      ...bridge.build(),
      branchCreate: () =>
        Promise.resolve({ ok: false, error: { kind: 'git-failed', message: '同名のブランチが既に存在します' } }),
    };
    const app = await load(failing);
    app.openCreateBranch();

    await app.createBranch('main', 'main', () => app.closeCreateBranch());

    expect(app.createBranchOpen).toBe(true);
    expect(app.error?.message).toBe('同名のブランチが既に存在します');
  });

  it('今いるブランチを作成ダイアログの既定値の元にする', async () => {
    const { app } = await boot();
    expect(app.currentBranch).toBe('main');
  });

  it('detached HEAD では起点が定まらないので作成ダイアログを開かない', async () => {
    const { app } = await boot((b) => {
      b.head = { oid: 'abc', branch: null, detached: true, upstream: null, ahead: 0, behind: 0 };
    });

    app.openCreateBranch();

    expect(app.currentBranch).toBeNull();
    expect(app.createBranchOpen).toBe(false);
  });
});

describe('ステージ切替と、そのあとの選択位置', () => {
  it('ダブルクリックでステージへ移す', async () => {
    const { app, bridge } = await boot((b) => {
      b.changes = [entry('a.txt')];
    });

    await app.toggleStage({ path: 'a.txt', staged: false });

    expect(bridge.countOf('stage')).toBe(1);
    expect(bridge.lastArgsOf('stage')?.[1]).toEqual({ kind: 'paths', paths: ['a.txt'] });
    expect(app.staged.entries.some((e) => e?.path === 'a.txt')).toBe(true);
  });

  it('ダブルクリックでステージ済みから戻す', async () => {
    const { app, bridge } = await boot((b) => {
      b.staged = [entry('a.txt', { staged: 'M' })];
    });

    await app.toggleStage({ path: 'a.txt', staged: true });

    expect(bridge.countOf('unstage')).toBe(1);
    expect(app.changes.entries.some((e) => e?.path === 'a.txt')).toBe(true);
  });

  it('ステージすると選択が 1 行下へ移る', async () => {
    const { app } = await boot((b) => {
      b.changes = [entry('a.txt'), entry('b.txt'), entry('c.txt')];
    });
    await app.select({ path: 'b.txt', staged: false });

    await app.toggleStage({ path: 'b.txt', staged: false });

    expect(app.selected).toEqual({ path: 'c.txt', staged: false });
  });

  it('一番下をステージすると 1 行上へ移る', async () => {
    const { app } = await boot((b) => {
      b.changes = [entry('a.txt'), entry('b.txt'), entry('c.txt')];
    });
    await app.select({ path: 'c.txt', staged: false });

    await app.toggleStage({ path: 'c.txt', staged: false });

    expect(app.selected).toEqual({ path: 'b.txt', staged: false });
  });

  it('最後の 1 件をステージすると選択が外れる', async () => {
    const { app } = await boot((b) => {
      b.changes = [entry('a.txt')];
    });
    await app.select({ path: 'a.txt', staged: false });

    await app.toggleStage({ path: 'a.txt', staged: false });

    expect(app.selected).toBeNull();
    expect(app.diff).toBeNull();
  });

  it('複数選択でステージすると、一番下の次へ移る', async () => {
    const { app } = await boot((b) => {
      b.changes = [entry('a.txt'), entry('b.txt'), entry('c.txt'), entry('d.txt')];
    });
    await app.select({ path: 'a.txt', staged: false });

    await app.stage({ kind: 'paths', paths: ['a.txt', 'b.txt', 'c.txt'] });

    expect(app.selected).toEqual({ path: 'd.txt', staged: false });
  });

  it('すべてステージでは選択を解除する', async () => {
    const { app } = await boot((b) => {
      b.changes = [entry('a.txt'), entry('b.txt')];
    });
    await app.select({ path: 'a.txt', staged: false });

    await app.stage({ kind: 'filtered', filter: { group: 'changes' } });

    expect(app.selected).toBeNull();
  });

  it('反対側のリストを選んでいるときは動かさない', async () => {
    const { app } = await boot((b) => {
      b.changes = [entry('a.txt'), entry('b.txt')];
      b.staged = [entry('z.txt', { staged: 'M' })];
    });
    await app.select({ path: 'z.txt', staged: true });

    await app.stage({ kind: 'paths', paths: ['a.txt'] });

    expect(app.selected).toEqual({ path: 'z.txt', staged: true });
  });

  it('失敗しても移動先の選択は元に戻さない（一覧は変わっていないので選び直せる）', async () => {
    const bridge = new FakeBridge();
    bridge.changes = [entry('a.txt'), entry('b.txt')];
    const app = await load({
      ...bridge.build(),
      stage: () =>
        Promise.resolve({
          ok: false as const,
          error: { kind: 'git-failed' as const, message: '失敗しました' },
        }),
    });
    await app.select({ path: 'a.txt', staged: false });

    await app.toggleStage({ path: 'a.txt', staged: false });

    expect(app.selected).toEqual({ path: 'b.txt', staged: false });
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

describe('diff の取得競合', () => {
  it('遅れて届いた古い応答は、新しい選択の差分を上書きしない', async () => {
    const { app, bridge } = await boot((b) => {
      b.changes = [entry('a.txt'), entry('b.txt')];
      b.diffDelayMs = 20;
    });

    // a → b と続けて選ぶ。a の応答のほうが後に届く状況を作る
    const first = app.select({ path: 'a.txt', staged: false });
    bridge.diffDelayMs = 1;
    const second = app.select({ path: 'b.txt', staged: false });
    await Promise.all([first, second]);
    await new Promise((r) => setTimeout(r, 40));

    expect(app.selected).toEqual({ path: 'b.txt', staged: false });
    expect(app.diff?.path).toBe('b.txt');
    expect(app.diffLoading).toBe(false);
  });

  it('選択が外れたあとに届いた応答も取り込まない', async () => {
    const { app } = await boot((b) => {
      b.changes = [entry('a.txt')];
      b.diffDelayMs = 20;
    });

    const pending = app.select({ path: 'a.txt', staged: false });
    await app.stage({ kind: 'filtered', filter: { group: 'changes' } });
    await pending;
    await new Promise((r) => setTimeout(r, 40));

    expect(app.selected).toBeNull();
    expect(app.diff).toBeNull();
  });
});

describe('hunk / 行単位のステージ (対応表 #33 / #34)', () => {
  const hunk = { index: 0, header: "@@ -1,3 +1,3 @@", lineCount: 4, lines: null };

  it('選択中のファイルのパスを添えて送る', async () => {
    const { app, bridge } = await boot((b) => {
      b.changes = [entry('a.txt')];
    });
    await app.select({ path: 'a.txt', staged: false });

    await app.stageHunks([hunk]);

    expect(bridge.countOf('stageHunks')).toBe(1);
    expect(bridge.lastArgsOf('stageHunks')?.[1]).toEqual({ path: 'a.txt', hunks: [hunk] });
  });

  it('アンステージも同じ形で送る', async () => {
    const { app, bridge } = await boot((b) => {
      b.staged = [entry('a.txt', { staged: 'M' })];
    });
    await app.select({ path: 'a.txt', staged: true });

    await app.unstageHunks([hunk]);

    expect(bridge.countOf('unstageHunks')).toBe(1);
    expect(bridge.lastArgsOf('unstageHunks')?.[1]).toEqual({ path: 'a.txt', hunks: [hunk] });
  });

  it('選択が無いときや空のときは IPC を呼ばない', async () => {
    const { app, bridge } = await boot((b) => {
      b.changes = [entry('a.txt')];
    });

    await app.stageHunks([hunk]);
    await app.select({ path: 'a.txt', staged: false });
    await app.stageHunks([]);

    expect(bridge.countOf('stageHunks')).toBe(0);
  });

  it('成功したら一覧と差分を取り直す（選択は動かさない）', async () => {
    const { app, bridge } = await boot((b) => {
      b.changes = [entry('a.txt'), entry('b.txt')];
    });
    await app.select({ path: 'a.txt', staged: false });
    const before = bridge.countOf('diffGet');

    await app.stageHunks([hunk]);

    expect(app.selected).toEqual({ path: 'a.txt', staged: false });
    expect(bridge.countOf('statusGetSummary')).toBeGreaterThan(0);
    expect(bridge.countOf('diffGet')).toBeGreaterThan(before);
  });
});

describe('ブランチのマージ (対応表 #35)', () => {
  it('確認を求められたら内容を保持し、承認で confirmed つきに再送する', async () => {
    const { app, bridge } = await boot((b) => {
      b.requireConfirmation = 'branchMerge';
    });

    await app.mergeBranch('topic');

    expect(app.pendingConfirmation?.confirmation.action).toBe('merge-branch');

    await app.acceptConfirmation();

    expect(bridge.confirmedCalls).toEqual(['branchMerge']);
    expect(app.pendingConfirmation).toBeNull();
  });

  it('キャンセルすると再送しない', async () => {
    const { app, bridge } = await boot((b) => {
      b.requireConfirmation = 'branchMerge';
    });

    await app.mergeBranch('topic');
    app.cancelConfirmation();

    expect(app.pendingConfirmation).toBeNull();
    expect(bridge.confirmedCalls).toEqual([]);
    expect(bridge.countOf('branchMerge')).toBe(1);
  });
});
