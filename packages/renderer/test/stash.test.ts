import { describe, expect, it } from 'vitest';
import type { FeatherTreeBridge } from '@feathertree/ipc';
import { AppState } from '../src/lib/appState.svelte.js';
import { TabActivity } from '../src/lib/tabActivity.js';
import { FakeBridge, entry, installDocumentStub, stash } from './fakeBridge.js';

installDocumentStub();

async function load(bridge: FeatherTreeBridge): Promise<AppState> {
  const app = new AppState(bridge, { tabActivity: new TabActivity({ delayMs: 0, minMs: 0, graceMs: 0 }) });
  await app.initialize();
  return app;
}

async function boot(setup?: (bridge: FakeBridge) => void): Promise<{ app: AppState; bridge: FakeBridge }> {
  const bridge = new FakeBridge();
  setup?.(bridge);
  const app = await load(bridge.build());
  return { app, bridge };
}

/**
 * Stash 保存モードと解放モード（決定 31）の状態機械。
 *
 * 見たいのは「いつ git を呼ぶか／呼ばないか」と、
 * 「pop / drop で消えた stash を選んだままにしない」こと。
 */
describe('Stash 解放モード: 一覧の取得', () => {
  it('モードに入るまで #28 を打たない（見えていないもののために git を起動しない）', async () => {
    const { app, bridge } = await boot((b) => {
      b.stashes = [stash(0)];
    });

    // 起動しただけ・差分モードのまま
    expect(bridge.countOf('stashList')).toBe(0);

    await app.ensureStashes();
    expect(bridge.countOf('stashList')).toBe(1);
    expect(app.stashes).toHaveLength(1);
  });

  it('2 度目の ensureStashes では打ち直さない', async () => {
    const { app, bridge } = await boot((b) => {
      b.stashes = [stash(0)];
    });

    await app.ensureStashes();
    await app.ensureStashes();
    expect(bridge.countOf('stashList')).toBe(1);
  });

  /*
   * **0 件は普通の状態**。件数で「取得済みか」を判定すると、stash を 1 つも持たない
   * 利用者は解放モードを開くたびに git が走る。
   */
  it('0 件でも取得済みとして扱う', async () => {
    const { app, bridge } = await boot();

    await app.ensureStashes();
    await app.ensureStashes();

    expect(app.stashes).toHaveLength(0);
    expect(app.stashesLoaded).toBe(true);
    expect(bridge.countOf('stashList')).toBe(1);
  });

  it('解放モードで更新を押すと一覧も取り直す', async () => {
    const { app, bridge } = await boot((b) => {
      b.settings = { ...b.settings, viewMode: 'stash-list' };
      b.stashes = [stash(0)];
    });

    await app.ensureStashes();
    await app.refresh('full');

    expect(bridge.countOf('stashList')).toBe(2);
  });

  it('差分モードで更新を押しても一覧は取り直さない', async () => {
    const { app, bridge } = await boot((b) => {
      b.stashes = [stash(0)];
    });

    await app.ensureStashes();
    await app.refresh('full');

    expect(bridge.countOf('stashList')).toBe(1);
  });
});

describe('Stash 解放モード: 選択と詳細', () => {
  it('stash を選ぶと変更ファイルを 1 回だけ取り、ファイルを選ぶと diff を取る', async () => {
    const { app, bridge } = await boot((b) => {
      b.stashes = [stash(0), stash(1)];
      b.stashFiles = [{ status: 'M', path: 'a.txt', origPath: null }];
    });
    await app.ensureStashes();

    await app.selectStash('stash-oid-0');
    expect(bridge.countOf('stashGetFiles')).toBe(1);
    expect(app.stashFiles).toHaveLength(1);

    // 同じものを選び直しても増えない
    await app.selectStash('stash-oid-0');
    expect(bridge.countOf('stashGetFiles')).toBe(1);

    await app.selectStashPath('a.txt');
    expect(bridge.countOf('stashGetDiff')).toBe(1);
    expect(app.stashDiff?.path).toBe('a.txt');
    // stash からはステージできない
    expect(app.stashDiff?.hunkStageable).toBe(false);
  });

  it('別の stash へ移ると、前の stash のファイル選択と差分を捨てる', async () => {
    const { app } = await boot((b) => {
      b.stashes = [stash(0), stash(1)];
      b.stashFiles = [{ status: 'M', path: 'a.txt', origPath: null }];
    });
    await app.ensureStashes();
    await app.selectStash('stash-oid-0');
    await app.selectStashPath('a.txt');

    await app.selectStash('stash-oid-1');

    expect(app.selectedStashPath).toBeNull();
    expect(app.stashDiff).toBeNull();
  });

  it('一覧に無い oid は選べない（git も呼ばない）', async () => {
    const { app, bridge } = await boot((b) => {
      b.stashes = [stash(0)];
    });
    await app.ensureStashes();

    await app.selectStash('どこにも無い');

    expect(app.selectedStash).toBeNull();
    expect(bridge.countOf('stashGetFiles')).toBe(0);
  });
});

describe('Stash 保存モード: 保存', () => {
  it('ステージ済みとメッセージが揃って初めて保存できる', async () => {
    const { app } = await boot((b) => {
      b.staged = [entry('a.txt', { staged: 'M' })];
    });

    expect(app.canSaveStash).toBe(false);
    app.stashMessage = '退避のメモ';
    expect(app.canSaveStash).toBe(true);

    app.stashMessage = '   ';
    expect(app.canSaveStash).toBe(false);
  });

  it('ステージ済みが無ければ保存できない', async () => {
    const { app } = await boot();
    app.stashMessage = '退避のメモ';
    expect(app.canSaveStash).toBe(false);
  });

  it('古い git では保存だけを止める', async () => {
    const { app } = await boot((b) => {
      b.staged = [entry('a.txt', { staged: 'M' })];
      b.supportsStagedStash = false;
    });

    app.stashMessage = '退避のメモ';
    expect(app.canUseStagedStash).toBe(false);
    expect(app.canSaveStash).toBe(false);
  });

  it('保存すると一覧に増え、メッセージ欄が空になり、status を取り直す', async () => {
    const { app, bridge } = await boot((b) => {
      b.staged = [entry('a.txt', { staged: 'M' })];
    });
    app.stashMessage = '退避のメモ';

    await app.saveStash();

    expect(bridge.countOf('stashSave')).toBe(1);
    expect(app.stashes).toHaveLength(1);
    expect(app.stashes[0]?.message).toContain('退避のメモ');
    expect(app.stashMessage).toBe('');
    // 応答に載っている一覧をそのまま使うので、#28 は打ち直さない
    expect(bridge.countOf('stashList')).toBe(0);
    expect(bridge.countOf('statusGetSummary')).toBeGreaterThan(1);
  });

  /*
   * docs/02-git-command-map.md #27 の実測表 5 行目。
   * **失敗しても stash はできていることがある**ので、失敗の側でも取り直す。
   * 取り直さないと「エラーが出たのに stash が増えている」ことが画面に出ない。
   */
  it('失敗しても status と一覧を取り直す（stash だけができている場合があるため）', async () => {
    const { app, bridge } = await boot((b) => {
      b.staged = [entry('a.txt', { staged: 'M' })];
      b.stashSaveError = {
        kind: 'git-failed',
        message: 'ステージした変更を作業ツリーから取り除けませんでした。',
      };
    });
    app.stashMessage = '近接する変更';

    await app.saveStash();

    expect(app.error?.message).toContain('取り除けませんでした');
    // 失敗の側でも #28 を打ち直しているので、増えた stash が画面に出る
    expect(bridge.countOf('stashList')).toBe(1);
    expect(app.stashes).toHaveLength(1);
    // メッセージは消さない（もう一度やり直せるように）
    expect(app.stashMessage).toBe('近接する変更');
  });
});

describe('stash の展開と破棄', () => {
  it('pop すると一覧から消え、選択も畳む', async () => {
    const { app } = await boot((b) => {
      b.stashes = [stash(0), stash(1)];
      b.stashFiles = [{ status: 'M', path: 'a.txt', origPath: null }];
    });
    await app.ensureStashes();
    await app.selectStash('stash-oid-0');
    await app.selectStashPath('a.txt');

    await app.applyStash({ index: 0, oid: 'stash-oid-0' }, true);

    expect(app.stashes).toHaveLength(1);
    // 消えた stash を選んだままにしない
    expect(app.selectedStash).toBeNull();
    expect(app.stashFiles).toHaveLength(0);
    expect(app.stashDiff).toBeNull();
  });

  it('apply では一覧も選択もそのまま', async () => {
    const { app } = await boot((b) => {
      b.stashes = [stash(0)];
      b.stashFiles = [{ status: 'M', path: 'a.txt', origPath: null }];
    });
    await app.ensureStashes();
    await app.selectStash('stash-oid-0');

    await app.applyStash({ index: 0, oid: 'stash-oid-0' }, false);

    expect(app.stashes).toHaveLength(1);
    expect(app.selectedStash).toBe('stash-oid-0');
  });

  it('破棄は main が確認を強制し、承認すると消える', async () => {
    const { app, bridge } = await boot((b) => {
      b.stashes = [stash(0)];
      b.requireConfirmation = 'stashDrop';
    });
    await app.ensureStashes();

    await app.dropStash({ index: 0, oid: 'stash-oid-0' });

    // まだ消えていない。確認を待っている
    expect(app.pendingConfirmation?.confirmation.action).toBe('stash-drop');
    expect(app.stashes).toHaveLength(1);

    await app.acceptConfirmation();

    expect(bridge.confirmedCalls).toContain('stashDrop');
    expect(app.stashes).toHaveLength(0);
  });

  it('展開が失敗しても、作業ツリーと一覧を取り直す', async () => {
    const { app, bridge } = await boot((b) => {
      b.stashes = [stash(0)];
    });
    await app.ensureStashes();

    // pop のコンフリクト（exit 1 でも作業ツリーは書き換わっている）を模す
    const failing = {
      ...bridge.build(),
      stashApply: () =>
        Promise.resolve({
          ok: false as const,
          error: { kind: 'git-failed' as const, message: 'コンフリクトが発生しました。' },
        }),
    };
    const app2 = await load(failing);
    await app2.ensureStashes();

    // 失敗した 1 回ぶんだけを数える
    const beforeApply = bridge.countOf('stashList');
    const statusBefore = bridge.countOf('statusGetSummary');
    await app2.applyStash({ index: 0, oid: 'stash-oid-0' }, true);

    expect(app2.error?.message).toContain('コンフリクト');
    expect(bridge.countOf('stashList')).toBe(beforeApply + 1);
    expect(bridge.countOf('statusGetSummary')).toBe(statusBefore + 1);
  });
});

describe('タブとの関係', () => {
  it('タブを切り替えても一覧を取り直さない（キャッシュから戻す）', async () => {
    const { app, bridge } = await boot((b) => {
      b.stashes = [stash(0)];
    });
    await app.ensureStashes();
    expect(bridge.countOf('stashList')).toBe(1);

    await app.activate('s2');
    // 別のタブは別のリポジトリ。まだ取っていない
    expect(app.stashesLoaded).toBe(false);
    await app.ensureStashes();
    expect(bridge.countOf('stashList')).toBe(2);

    await app.activate('s1');
    // 戻ってきたら取り直さない
    expect(app.stashesLoaded).toBe(true);
    expect(app.stashes).toHaveLength(1);
    expect(bridge.countOf('stashList')).toBe(2);
  });
});
