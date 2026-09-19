/*
 * 実行されうるファイルの判定（脆弱性診断 §5 High）。
 *
 * `shell.openPath` は Windows の拡張子関連付けに従ってファイルを「開く」。
 * `.exe` 等ではこれがそのまま実行になる。悪意あるリポジトリ（クローン・pull で
 * 出現した untracked ファイルも含む）に混ぜておけば、利用者が「中身を確認しよう」と
 * 作業ツリーペインで右クリック→「開く」を選んだだけで任意コードが走る。
 *
 * ここでは「確認が要るかどうか」の判定だけを純関数として持つ。呼び出し側（main の
 * shellOpenPath）が実際の確認強制を、renderer（ConfirmDialog）が表示を担当する
 * （destructiveActions.ts と同じ役割分担）。git の操作ではないため DestructiveAction
 * には含めない——決定 16 は「不可逆・履歴が動く git 操作」の確認を最小化する方針だが、
 * ファイルを開くことは git 操作ではなく、その代わり任意コード実行に直結しうるという
 * 別種の危険を持つ。この判定はその例外の根拠になる。
 */

/**
 * Windows でダブルクリック等により実行されうる拡張子（大文字小文字を無視）。
 * 脆弱性診断 §5 が列挙したものに、`.msh` 系（Monad/PowerShell 初期のシェル関連）を展開して含める。
 */
const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.exe',
  '.com',
  '.scr',
  '.pif',
  '.bat',
  '.cmd',
  '.msi',
  '.msp',
  '.msc',
  '.cpl',
  '.reg',
  '.lnk',
  '.url',
  '.appref-ms',
  '.ps1',
  '.psm1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.hta',
  '.jar',
  '.chm',
  '.inf',
  '.scf',
  '.sct',
  '.hlp',
  '.cer',
  '.msh',
  '.msh1',
  '.msh2',
  '.mshxml',
  '.msh1xml',
  '.msh2xml',
]);

/**
 * ファイル名（パスの最後の要素）が、実行されうる拡張子を持つか。
 *
 * 大文字小文字は無視する（Windows のファイルシステムは大文字小文字を区別しない）。
 * `readme.txt.exe` のような複合拡張子は、常に**最後の拡張子だけ**を見れば取りこぼさない
 * （Windows 自身が「開く」ときに使うのも最後の拡張子だけ）。
 * `foo.exe.` や `foo.exe ` のように末尾に空白・ドットが続く名前は、Windows のファイル
 * システムが作成時に取り除くため、判定前に同じ規則で切り落としてから見る
 * （残したままだと拡張子が `.exe.` や `.exe ` になり、素直な集合の比較で漏れる）。
 */
export function isExecutableFileName(name: string): boolean {
  const trimmed = name.replace(/[ .]+$/u, '');
  const dot = trimmed.lastIndexOf('.');
  // 拡張子が無い、または名前の先頭がドットだけ（隠しファイル的な名前）は対象外
  if (dot <= 0) return false;
  const ext = trimmed.slice(dot).toLowerCase();
  return EXECUTABLE_EXTENSIONS.has(ext);
}

/**
 * 実行されうるファイルを開く前の確認内容（決定 16 の例外）。
 *
 * `destructiveActions.ts` の `ConfirmationSpec` と同じ形にしてあるが、DestructiveAction の
 * 一員にはしない（git 操作ではないため、あちらの列挙・一覧には載せない）。
 * `recoverable: false` にしているのは「復旧手段」の意味ではなく、実行してしまえば
 * その結果（ファイル改変・追加プロセスの起動等）自体は取り消せないため、
 * ConfirmDialog に「この操作は取り消せません。」の強い警告を出させる狙い。
 */
export const OPEN_EXECUTABLE_CONFIRMATION = {
  action: 'open-executable-file',
  title: 'このファイルを開きますか？',
  message:
    'このファイルは実行される可能性があります。開くとプログラムとして動き出すことがあります。' +
    'リポジトリの作者を信頼できる場合だけ開いてください。',
  confirmLabel: '開く',
  recoverable: false,
} as const;
