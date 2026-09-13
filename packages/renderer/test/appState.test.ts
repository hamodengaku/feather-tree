import { describe, expect, it } from 'vitest';
import type { FeatherTreeBridge } from '@feathertree/ipc';
import { AppState } from '../src/lib/appState.svelte.js';
import { FakeBridge, branch, commit, entry, installDocumentStub } from './fakeBridge.js';

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

  /*
   * 件名の出所は #3（for-each-ref）しかなく、#2 は件名を持たない。
   * 取り直さないとリポジトリタブに 1 つ前の件名が残る
   * （対応表の例外「コミット後の反映: #10 → #2 → #3」）。
   */
  it('コミット成功後はブランチ一覧も取り直す（件名を新鮮に保つため）', async () => {
    const { app, bridge } = await boot((b) => {
      b.staged = [entry('a.txt', { staged: 'M' })];
    });
    app.commitMessage = 'コミットする';
    const before = bridge.countOf('branchList');

    await app.commit();

    expect(bridge.countOf('branchList')).toBe(before + 1);
  });

  it('確認待ちで止まったコミットではブランチ一覧を取り直さない', async () => {
    const { app, bridge } = await boot((b) => {
      b.staged = [entry('a.txt', { staged: 'M' })];
      b.requireConfirmation = 'commit';
    });
    app.commitMessage = 'やり直す';
    app.amend = true;
    const before = bridge.countOf('branchList');

    await app.commit();
    expect(app.pendingConfirmation).not.toBeNull();
    expect(bridge.countOf('branchList')).toBe(before);

    // 承認して実際にコミットされたら取り直す
    await app.acceptConfirmation();
    expect(bridge.countOf('branchList')).toBe(before + 1);
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

describe('リモート操作 (対応表 #22〜#25)', () => {
  it('フェッチはリモート名を渡し、ブランチ一覧も取り直す（ahead/behind が変わるため）', async () => {
    const { app, bridge } = await boot();
    const before = bridge.countOf('branchList');

    await app.fetch('origin');

    expect(bridge.lastArgsOf('remoteFetch')).toEqual(['s1', 'origin']);
    expect(bridge.countOf('branchList')).toBe(before + 1);
    expect(app.error).toBeNull();
  });

  it('プルはセッション id だけを渡す（どこから取るかは git の設定に委ねる）', async () => {
    const { app, bridge } = await boot();

    await app.pull();

    expect(bridge.lastArgsOf('remotePull')).toEqual(['s1']);
  });

  it('上流が無いブランチのプッシュは --set-upstream つきで送る（対応表 #25）', async () => {
    const { app, bridge } = await boot();

    await app.push('origin', 'feature', true);

    expect(bridge.lastArgsOf('remotePush')).toEqual([
      's1',
      { remote: 'origin', branch: 'feature', setUpstream: true },
    ]);
  });

  it('リモート一覧はセッションを開いたときに取る', async () => {
    const { app, bridge } = await boot((b) => {
      b.remotes = ['origin', 'upstream'];
    });

    expect(app.remotes).toEqual(['origin', 'upstream']);
    expect(bridge.countOf('remoteList')).toBe(1);
  });

  it('プッシュのダイアログはリモートが無ければ開かない', async () => {
    const { app } = await boot((b) => {
      b.remotes = [];
    });

    app.openPushDialog();

    expect(app.pushDialogOpen).toBe(false);
  });

  it('プッシュに成功したときだけダイアログを閉じる', async () => {
    const { app } = await boot();
    app.openPushDialog();
    expect(app.pushDialogOpen).toBe(true);

    await app.push('origin', 'main', false, () => app.closePushDialog());

    expect(app.pushDialogOpen).toBe(false);
  });

  it('プッシュに失敗したらダイアログは開いたままにする（条件を変えて試し直せる）', async () => {
    const bridge = new FakeBridge();
    const failing: FeatherTreeBridge = {
      ...bridge.build(),
      remotePush: () =>
        Promise.resolve({
          ok: false,
          error: { kind: 'git-failed', message: 'リモートに新しいコミットがあります' },
        }),
    };
    const app = await load(failing);
    app.openPushDialog();

    await app.push('origin', 'main', false, () => app.closePushDialog());

    expect(app.pushDialogOpen).toBe(true);
    expect(app.error?.message).toBe('リモートに新しいコミットがあります');
  });

  it('ターミナルで開くのはセッション id だけを渡す（パスは main が決める）', async () => {
    const { app, bridge } = await boot();

    await app.openTerminal();

    expect(bridge.lastArgsOf('shellOpenTerminal')).toEqual(['s1']);
    expect(app.error).toBeNull();
  });
});

describe('実行中の git コマンド (決定 26)', () => {
  it('開始で立ち、終了で消える', async () => {
    const { app, bridge } = await boot();

    bridge.emitCommandStart({ sessionId: 's1', opId: 's1:1', args: ['fetch', 'origin'] });
    expect(app.runningCommand?.args).toEqual(['fetch', 'origin']);

    bridge.emitCommandEnd('s1:1');
    expect(app.runningCommand).toBeNull();
  });

  it('並行して走っているときは最後に始まったものを映す', async () => {
    const { app, bridge } = await boot();

    bridge.emitCommandStart({ sessionId: 's1', opId: 's1:1', args: ['status'] });
    bridge.emitCommandStart({ sessionId: 's1', opId: 's1:2', args: ['diff', 'a.txt'] });
    expect(app.runningCommand?.args).toEqual(['diff', 'a.txt']);

    // 後から始まったほうが先に終わっても、残っているものへ戻るだけ
    bridge.emitCommandEnd('s1:2');
    expect(app.runningCommand?.args).toEqual(['status']);
  });

  it('他のタブで走っているものは映さない', async () => {
    const { app, bridge } = await boot();

    bridge.emitCommandStart({ sessionId: 's2', opId: 's2:1', args: ['status'] });

    expect(app.runningCommand).toBeNull();
    // ただし取りこぼし防止のため、保持自体はしている
    expect(app.runningCommands).toHaveLength(1);
  });
});

/*
 * リポジトリを開く経路（決定 26 の見え方に直結する）。
 *
 * 巨大リポジトリでは #2 が終わるまで数十秒かかる。その間タブが現れないと、
 * 実行中の git はアクティブでないセッションのものになりコマンドバーに映らず、
 * 画面は前のタブのまま動かない——つまり固まったようにしか見えない。
 * だから「タブを先に立てて、アクティブにしてから読み込む」順序を守る。
 */
describe('リポジトリを開く（タブを先に立てる）', () => {
  /** 保留中の IPC を挟んだ状態で、溜まったマイクロタスクを流し切る。 */
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('読み込みが終わる前にタブが立ち、アクティブになり、回転印が出る', async () => {
    const { app, bridge } = await boot((b) => {
      b.holdLoad = true;
    });

    const opening = app.openRepository();
    await flush();

    // まだ sessionLoad は返っていない
    expect(app.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(app.activeId).toBe('s3');
    expect(app.isLoading('s3')).toBe(true);
    expect(app.isLoading('s1')).toBe(false);

    bridge.releaseLoad();
    await opening;

    expect(app.isLoading('s3')).toBe(false);
  });

  it('タブを立ててから読み込む順序で呼ぶ', async () => {
    const { app, bridge } = await boot();

    await app.openRepository();

    const names = bridge.calls.map((c) => c.name);
    const created = names.indexOf('sessionPickAndCreate');
    const loaded = names.indexOf('sessionLoad');
    expect(created).toBeGreaterThanOrEqual(0);
    expect(loaded).toBeGreaterThan(created);
    expect(bridge.lastArgsOf('sessionLoad')).toEqual(['s3']);
  });

  it('読み込み中に走る git はアクティブなタブのものとしてコマンドバーに映る', async () => {
    const { app, bridge } = await boot((b) => {
      b.holdLoad = true;
    });

    const opening = app.openRepository();
    await flush();
    // main は新しいセッションの id で実行中を通知してくる
    bridge.emitCommandStart({ sessionId: 's3', opId: 's3:1', args: ['status'] });

    expect(app.runningCommand?.args).toEqual(['status']);

    bridge.emitCommandEnd('s3:1');
    bridge.releaseLoad();
    await opening;
  });

  it('キャンセルされたらタブは増えない', async () => {
    const { app, bridge } = await boot((b) => {
      b.pickResult = null;
    });

    await app.openRepository();

    expect(app.sessions).toHaveLength(2);
    expect(app.activeId).toBe('s1');
    expect(bridge.countOf('sessionLoad')).toBe(0);
  });

  it('既に開いているリポジトリを選んだらタブを増やさず切り替える', async () => {
    const { app, bridge } = await boot((b) => {
      b.pickResult = { id: 's2', root: 'D:/repo-two', displayName: 'repo-two' };
    });

    await app.openRepository();

    expect(app.sessions).toHaveLength(2);
    expect(app.activeId).toBe('s2');
    expect(bridge.countOf('sessionActivate')).toBe(1);
  });
});

/*
 * 「リポジトリを開く」のポップアップとクローン（対応表 #37）。
 * クローン後のタブの立ち方はローカルを開くときと同じ 2 段階（#37 → #1、その後 #2 〜 #4）。
 */
describe('リポジトリを開く口（ポップアップ）とクローン', () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const request = { url: 'https://example.com/owner/cloned.git', parentDir: 'D:/work', name: 'cloned', shallow: false };

  it('ポップアップは位置を持って開き、閉じると null に戻る', async () => {
    const { app } = await boot();

    app.showOpenRepositoryMenu(12, 34);
    expect(app.openRepoMenu).toEqual({ x: 12, y: 34 });

    app.closeOpenRepositoryMenu();
    expect(app.openRepoMenu).toBeNull();
  });

  it('クローンに成功するとダイアログを閉じ、タブを立ててから読み込む', async () => {
    const { app, bridge } = await boot();
    app.openCloneDialog();

    await app.cloneRepository(request, () => app.closeCloneDialog());

    expect(app.cloneDialogOpen).toBe(false);
    expect(app.cloning).toBe(false);
    expect(app.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's4']);
    expect(app.activeId).toBe('s4');
    expect(bridge.lastArgsOf('sessionCloneAndCreate')).toEqual([request]);
    const names = bridge.calls.map((c) => c.name);
    expect(names.indexOf('sessionLoad')).toBeGreaterThan(names.indexOf('sessionCloneAndCreate'));
    expect(bridge.lastArgsOf('sessionLoad')).toEqual(['s4']);
  });

  it('失敗したらダイアログは開いたままで、エラーを出し、タブは増えない', async () => {
    const { app, bridge } = await boot((b) => {
      b.cloneError = { kind: 'git-failed', message: 'リポジトリが見つかりません。URL を確認してください。' };
    });
    app.openCloneDialog();

    await app.cloneRepository(request, () => app.closeCloneDialog());

    expect(app.cloneDialogOpen).toBe(true);
    expect(app.cloning).toBe(false);
    expect(app.error?.message).toContain('リポジトリが見つかりません');
    expect(app.sessions).toHaveLength(2);
    expect(bridge.countOf('sessionLoad')).toBe(0);
  });

  it('進捗行はクローン中の sessionId: null だけを映し、実行中は閉じられない', async () => {
    const { app, bridge } = await boot((b) => {
      b.holdClone = true;
    });
    app.openCloneDialog();

    // 始まる前の行は拾わない
    bridge.emitProgress({ sessionId: null, opId: 'clone:0', line: '古い行' });
    expect(app.cloneProgress).toBeNull();

    const cloning = app.cloneRepository(request, () => app.closeCloneDialog());
    await flush();
    expect(app.cloning).toBe(true);

    bridge.emitProgress({ sessionId: null, opId: 'clone:1', line: 'Receiving objects:  45% (45/100)' });
    bridge.emitProgress({ sessionId: 's1', opId: 's1:9', line: '別セッションの行' });
    expect(app.cloneProgress).toBe('Receiving objects:  45% (45/100)');

    app.closeCloneDialog();
    expect(app.cloneDialogOpen).toBe(true);

    bridge.releaseClone();
    await cloning;
    expect(app.cloneDialogOpen).toBe(false);
  });

  it('保存先の選択をキャンセルしたら null', async () => {
    const { app, bridge } = await boot((b) => {
      b.clonePickResult = null;
    });

    expect(await app.pickCloneDirectory()).toBeNull();
    expect(bridge.countOf('clonePickDirectory')).toBe(1);
  });

  it('決定で確認に進み（git は動かない）、戻ると入力に戻る。閉じると確認も消える', async () => {
    const { app, bridge } = await boot();
    app.openCloneDialog();

    app.confirmClone(request);
    expect(app.cloneConfirm).toEqual(request);
    expect(bridge.countOf('sessionCloneAndCreate')).toBe(0);

    app.backToCloneForm();
    expect(app.cloneConfirm).toBeNull();
    expect(app.cloneDialogOpen).toBe(true);

    app.confirmClone(request);
    app.closeCloneDialog();
    expect(app.cloneDialogOpen).toBe(false);
    expect(app.cloneConfirm).toBeNull();
  });

  it('実行中は確認から戻れない。成功すると入力と確認の両方が閉じる', async () => {
    const { app, bridge } = await boot((b) => {
      b.holdClone = true;
    });
    app.openCloneDialog();
    app.confirmClone(request);

    const cloning = app.cloneRepository(request, () => app.closeCloneDialog());
    await flush();
    app.backToCloneForm();
    expect(app.cloneConfirm).toEqual(request);

    bridge.releaseClone();
    await cloning;
    expect(app.cloneConfirm).toBeNull();
    expect(app.cloneDialogOpen).toBe(false);
  });
});

describe('コミットログモード（決定 27）', () => {
  it('モードを切り替えると設定に永続化される', async () => {
    const { app, bridge } = await boot();

    expect(app.viewMode).toBe('diff');
    await app.setViewMode('log');

    expect(app.viewMode).toBe('log');
    expect(bridge.lastArgsOf('settingsUpdate')).toEqual([{ viewMode: 'log' }]);
  });

  it('モードに入るまで履歴は取らない（見えていないものに git を使わない）', async () => {
    const { app, bridge } = await boot((b) => {
      b.commits = [commit('aaa1111'), commit('bbb2222')];
    });

    // 起動しただけでは #20 は走らない
    expect(bridge.countOf('logGetPage')).toBe(0);

    await app.ensureLog();
    expect(bridge.countOf('logGetPage')).toBe(1);
    expect(app.commits.map((c) => c.oid)).toEqual(['aaa1111', 'bbb2222']);
    // ページ全体より少なく返ったので、これ以上は無い
    expect(app.logComplete).toBe(true);
  });

  it('取得済みなら ensureLog は IPC を呼ばない', async () => {
    const { app, bridge } = await boot((b) => {
      b.commits = [commit('aaa1111')];
    });

    await app.ensureLog();
    await app.ensureLog();

    expect(bridge.countOf('logGetPage')).toBe(1);
  });

  it('末尾まで読むと skip 付きで次のページを取り、最後まで来たら止まる', async () => {
    const { app, bridge } = await boot((b) => {
      b.settings = { ...b.settings, logPageSize: 2 };
      b.commits = [commit('c1'), commit('c2'), commit('c3')];
    });

    await app.ensureLog();
    expect(app.commits).toHaveLength(2);
    expect(app.logComplete).toBe(false);

    await app.loadMoreLog();
    expect(bridge.lastArgsOf('logGetPage')).toEqual(['s1', 2]);
    expect(app.commits.map((c) => c.oid)).toEqual(['c1', 'c2', 'c3']);
    // 1 件しか返らなかった（ページ未満）ので打ち止め
    expect(app.logComplete).toBe(true);

    await app.loadMoreLog();
    expect(bridge.countOf('logGetPage')).toBe(2);
  });

  it('コミットを選ぶと変更ファイル一覧を 1 回だけ取る', async () => {
    const { app, bridge } = await boot((b) => {
      b.commits = [commit('aaa1111')];
      b.commitFiles = [{ status: 'M', path: 'src/a.ts', origPath: null }];
    });

    await app.ensureLog();
    await app.selectCommit('aaa1111');

    expect(bridge.lastArgsOf('commitGetFiles')).toEqual(['s1', 'aaa1111']);
    expect(app.commitFiles.map((f) => f.path)).toEqual(['src/a.ts']);
    // ファイルを選ぶまで diff は取らない
    expect(bridge.countOf('commitGetDiff')).toBe(0);

    // 同じコミットを選び直しても git は増えない
    await app.selectCommit('aaa1111');
    expect(bridge.countOf('commitGetFiles')).toBe(1);
  });

  it('ファイルを選ぶとそのコミットの diff を取る', async () => {
    const { app, bridge } = await boot((b) => {
      b.commits = [commit('aaa1111')];
      b.commitFiles = [{ status: 'M', path: 'src/a.ts', origPath: null }];
    });

    await app.ensureLog();
    await app.selectCommit('aaa1111');
    await app.selectCommitPath('src/a.ts');

    expect(bridge.lastArgsOf('commitGetDiff')).toEqual(['s1', 'aaa1111', 'src/a.ts']);
    expect(app.commitDiff?.path).toBe('src/a.ts');
    // 過去のコミットからはステージできない
    expect(app.commitDiff?.hunkStageable).toBe(false);
  });

  it('別のコミットを選ぶと、前のコミットのファイル選択と差分は消える', async () => {
    const { app } = await boot((b) => {
      b.commits = [commit('aaa1111'), commit('bbb2222')];
      b.commitFiles = [{ status: 'M', path: 'src/a.ts', origPath: null }];
    });

    await app.ensureLog();
    await app.selectCommit('aaa1111');
    await app.selectCommitPath('src/a.ts');
    expect(app.commitDiff).not.toBeNull();

    await app.selectCommit('bbb2222');
    expect(app.selectedCommitPath).toBeNull();
    expect(app.commitDiff).toBeNull();
  });

  it('更新ボタンは、コミットログモードのときだけ履歴も取り直す', async () => {
    const { app, bridge } = await boot((b) => {
      b.commits = [commit('aaa1111')];
    });

    // 差分モードのままなら #20 は走らない
    await app.refresh('full');
    expect(bridge.countOf('logGetPage')).toBe(0);

    await app.setViewMode('log');
    await app.refresh('full');
    expect(bridge.countOf('logGetPage')).toBe(1);
  });

  it('タブを切り替えても履歴を取り直さない（保持しているものを見せる）', async () => {
    const { app, bridge } = await boot((b) => {
      b.commits = [commit('aaa1111')];
    });

    await app.ensureLog();
    await app.selectCommit('aaa1111');
    expect(bridge.countOf('logGetPage')).toBe(1);

    await app.activate('s2');
    expect(app.commits).toHaveLength(0);
    expect(app.selectedCommit).toBeNull();

    await app.activate('s1');
    expect(app.commits.map((c) => c.oid)).toEqual(['aaa1111']);
    expect(app.selectedCommit).toBe('aaa1111');
    // s1 に戻っても #20 は増えない
    expect(bridge.countOf('logGetPage')).toBe(1);
  });
});

describe('HEAD の件名（リポジトリタブに出す）', () => {
  it('status 由来のブランチ名で一覧を引き、件名を返す', async () => {
    const { app } = await boot((b) => {
      b.branches = [
        branch('main', { isHead: true, oid: 'aaa', subject: 'main の件名' }),
        branch('other', { oid: 'bbb', subject: 'other の件名' }),
      ];
      b.head = { oid: 'aaa', branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0 };
    });

    expect(app.headSubject).toBe('main の件名');
  });

  /*
   * 切替直後は一覧を取り直さない（#12 → #2）ので、一覧の isHead は前のブランチに付いたまま。
   * isHead を信じると別のブランチの件名を出してしまう。判定は必ず status 由来で行う。
   */
  it('一覧の isHead が古くても、status が指すブランチの件名を出す', async () => {
    const { app } = await boot((b) => {
      b.branches = [
        branch('main', { isHead: true, oid: 'aaa', subject: '古い HEAD の件名' }),
        branch('feature', { oid: 'bbb', subject: '切り替えた先の件名' }),
      ];
      // status だけが新しい（feature へ切り替えた直後の状態）
      b.head = { oid: 'bbb', branch: 'feature', detached: false, upstream: null, ahead: 0, behind: 0 };
    });

    expect(app.headSubject).toBe('切り替えた先の件名');
  });

  it('detached HEAD では oid の一致で探す', async () => {
    const { app } = await boot((b) => {
      b.branches = [branch('main', { oid: 'ccc', subject: 'その位置の件名' })];
      b.head = { oid: 'ccc', branch: null, detached: true, upstream: null, ahead: 0, behind: 0 };
    });

    expect(app.headSubject).toBe('その位置の件名');
  });

  it('どのブランチの先端でもない位置なら null（タブには件名を出さない）', async () => {
    const { app } = await boot((b) => {
      b.branches = [branch('main', { oid: 'aaa', subject: 'main の件名' })];
      b.head = { oid: 'zzz', branch: null, detached: true, upstream: null, ahead: 0, behind: 0 };
    });

    expect(app.headSubject).toBeNull();
  });

  it('コミットがまだ無いリポジトリでは null', async () => {
    const { app } = await boot((b) => {
      b.head = { oid: null, branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0 };
    });

    expect(app.headSubject).toBeNull();
  });

  it('タブへの現在情報の表示は設定で切れる（既定はオン）', async () => {
    const { app, bridge } = await boot();

    expect(app.settings?.tabShowCurrentInfo).toBe(true);
    await app.setTabShowCurrentInfo(false);

    expect(bridge.lastArgsOf('settingsUpdate')).toEqual([{ tabShowCurrentInfo: false }]);
    expect(app.settings?.tabShowCurrentInfo).toBe(false);
  });
});
