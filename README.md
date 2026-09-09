# FeatherTree

軽量な git GUI クライアント。

大規模開発でのブランチ移動に耐えることを目的に、
** git 操作を素の git コマンドと 1:1 で対応させ、アプリ都合の付随処理を少なくする**方針で作っている。

## 動作要件

- Windows 10 / 11（x64）
- **Git for Windows が必須**（2.25 以降。`--pathspec-from-file` を使うため）
  - FeatherTree は git を同梱しない。未検出の場合は導入を案内する

## 配布形態

| 形式 | 特徴 |
|------|------|
| `FeatherTree-<version>-portable.exe` | 単一 exe。インストール不要。**初回起動時に %TEMP% へ展開するため初回だけ遅い** |
| `FeatherTree-<version>-win.zip` | 展開型。起動が速い。フォルダごと持ち運べる |

いずれも設定・データは **exe と同じ場所の `FeatherTree-data/`** に保存する。
`%APPDATA%` には何も書き込まない。

未署名のため、初回実行時に Windows SmartScreen の警告が表示される。

## 開発

```bash
npm install          # 依存の取得（キャッシュはリポジトリ内に閉じる）
npm run dev          # 開発起動（HMR あり）
npm run verify       # 依存方向検査 + 型検査 + テスト
npm run dist         # 配布物のビルド（release/ に出力）
npm run measure      # 配布 exe のサイズ・起動時間・メモリを実測
```

### npm コマンドはリポジトリルートから実行すること

`.npmrc` でキャッシュを `.cache/npm` などの**相対パス**に向けている。
相対パスは実行時カレントディレクトリ基準で解決されるため、
別ディレクトリから実行するとキャッシュ位置が変わる。

### ローカル環境を汚さない

npm と Electron のキャッシュ、開発時の userData、テストの一時ファイルはすべて
リポジトリ内（`.cache/` `.tmp/`）に閉じている。
`%APPDATA%` や `%LOCALAPPDATA%` には何も書き込まない。
`.npmrc` と `scripts/*.mjs`、`packages/base-electron/src/paths.ts` で担保している。

## 設計の要点

### 層の分離をプロセス境界で強制する

View 層（renderer）は `sandbox: true` で動くため `child_process` も `fs` も存在しない。
逆に git 操作層とアプリ制御層は `electron` を import しないので、Electron 抜きでテストできる。
参照方向は `.dependency-cruiser.cjs` で機械的に検査する（`npm run lint:deps`）。

### git 操作は素の git コマンドと 1:1 で対応させる

1 ユーザー操作 = 1 git プロセスを原則とし、複数プロセスを許す例外は限定する。
アプリ都合のチェックやスキャンを前後に挟まない。
実行した git コマンドは引数を伏せずにすべて「実行ログ」パネルに出す。

### 巨大リポジトリ対応

`git status` のスナップショットは main プロセスに置き、renderer には可視範囲だけを渡す。
10 万件のパス配列を IPC で往復させない。「すべてステージ」は範囲指定を送るだけで、
パス一覧は main 側で組み立てて `--pathspec-from-file` に書き出す。

### 破壊的操作の確認は main 側で強制する

renderer が確認せずに呼ぶと main が拒否する。「確認ダイアログを表示するだけ」にしないので、
UI のバグで破棄が通ることがない。

## 構成

```
packages/
  base-contract/  土台: 依存ゼロの Result 型
  base-core/      土台: 純 Node のユーティリティ（設定 / ログ / 直列化 / パス検証）
  base-electron/  土台: main プロセス側（userData 解決 / 安全設定 / IPC ラッパ）
  base-ui/        土台: renderer 側（テーマ / 仮想化リスト / ブリッジ）

  git/            git 操作層（Electron を知らない純 Node）
  core/           アプリ制御層（electron を import しない）
  ipc/            main と renderer の契約（型と定数のみ）
  main/           Electron main プロセス
  preload/        contextBridge の境界
  renderer/       View 層（Svelte。Node API に到達できない）
```

`base-*` は FeatherTree を一切知らない土台で、他の Windows ツールへ流用できる。
土台から FeatherTree 側を import すると `npm run lint:deps` がエラーになる。

View 層は `sandbox: true` で動くため、`child_process` も `fs` も**そもそも存在しない**。
層の分離は約束ではなく物理的な制約になっている。

## 開発について （本項のみ開発者の直筆です）

このプロジェクトは、技術選定・ソースコード実装にAI コーディングアシスタント（Anthropic Claude）を活用しています。
すべての工程において開発者レビューを行っています。
ロゴをはじめとするイラスト領域については、最終的にAIフリーなリリースを予定しています。（開発段階は仮図です）

## ライセンス

[MIT ライセンス](LICENSE)。  
ただしロゴ等のイラスト・デザイン領域については、良心に基づく2次利用のみを認め、開発者への事前連絡を強く推奨する。

配布物（exe / zip）には Electron / Chromium / Node.js / Svelte などが同梱され、
それぞれのライセンス条件（MIT / BSD / Apache-2.0 等）に従う。
