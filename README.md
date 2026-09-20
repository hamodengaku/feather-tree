# FeatherTree

羽のように軽い git GUI クライアントソフトです。  
ゲームエンジン（Unity）を用いた大規模リポジトリのクローンやブランチ移動に耐えることを目指しています。

※本ソフトは、同人頒布物です。ご利用は自己責任で。

## 使い方

### 動作要件

- Windows 10 / 11（x64）
- **Git for Windows が必要です**（2.25～ `--pathspec-from-file` を使います）
  - **一部の機能は 2.35～ が必要です**（スタッシュ時に`git stash push --staged` を使います）

### インストール

1. [Releases](https://github.com/hamodengaku/feather-tree/releases) から `FeatherTree-Setup-x.y.z.exe` をダウンロード
2. ダブルクリックして実行

※同人頒布のため、未署名です。  
**「Windows によって PC が保護されました」という SmartScreen の警告が出た場合**は、「詳細情報」→「実行」の順に進めてください。  

### アップデート

新バージョンが公開されると、ソフト起動時にお知らせが出ます。  
GitHubから手動ダウンロードいただき `Setup.exe` を実行すれば、設定を保持したまま更新できます。

### アンインストール

Windows の「設定 → アプリ → インストールされているアプリ」から「FeatherTree」を選んでアンインストールしてください。  
なお、以下の設定データは削除されずに残ります。必要に応じて、手動で削除してください。

| 導入方法 | 保存先 |
|---------|--------|
| インストーラー版（Setup.exe） | `%APPDATA%\FeatherTree` |
| zip 展開版 | 展開した exe と同じフォルダの `FeatherTree-data` |

### 安全のしおり

- **信頼できない「git リポジトリ」（`.git` を含む zip など）は、そのまま開かないでください。**  
  リポジトリ（≒フォルダ）内に悪意のあるプログラムが仕込まれている可能性あり、   
  本ソフトに限らず、gitコマンドや類似gitクライアントでは、それらの実行を防御できません。  
- **クローンする URL にパスワードやトークンを直接埋め込まないでください。**  
（例：`https://user:TOKEN@host/...`）  
  入力せずとも、 Git Credential Manager（Git for Windows に同梱）によって、初回サインイン画面が出ます。

### zip 展開版（上級者向け）

インストーラーを使用しない場合は、  
Releases の `FeatherTree-x.y.z-win-x64.zip` を展開して `FeatherTree.exe` を起動してください。

---------------------

## 開発体制（AI活用）について

本プロジェクトは、技術選定・ソースコード実装にAI コーディングアシスタント（Anthropic Claude）を活用しています。  
ロゴをはじめとするイラスト・デザイン領域には、（ファーストコミットの仮画像を除き）AIを使用していません。

## ライセンス

[MIT ライセンス](LICENSE)  
ただしロゴ等のイラスト・デザイン領域については、良心に基づく2次利用のみを認め、開発者への事前連絡を強く推奨します。

配布物（exe / zip）には、 Electron / Chromium / Node.js / Svelte などが同梱され、  
それぞれのライセンス条件（MIT / BSD / Apache-2.0 等）に従います。

-------------------------


## 技術詳細（開発者向け）

```bash
npm install          # 依存の取得（キャッシュはリポジトリ内に閉じる）
npm run dev          # 開発起動（HMR あり）
npm run verify       # 依存方向検査 + 型検査 + テスト
npm run dist         # 配布物のビルド（release/ に出力。Setup.exe + zip）
npm run measure      # 配布 exe のサイズ・起動時間・メモリを実測
```

### npm コマンドはリポジトリルートから実行すること

`.npmrc` でキャッシュを `.cache/npm` などの**相対パス**に向けている。
相対パスは実行時カレントディレクトリ基準で解決されるため、
別ディレクトリから実行するとキャッシュ位置が変わる。

### ローカル環境を汚さない

npm と Electron のキャッシュ、開発時の userData、テストの一時ファイルはすべて
リポジトリ内（`.cache/` `.tmp/`）に閉じている。
`%APPDATA%` や `%LOCALAPPDATA%` には何も書き込まない（インストール版の userData を除く。上記参照）。
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
