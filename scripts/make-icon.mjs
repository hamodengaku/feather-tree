// build/icon/*.png を、Windows 用の build/icon.ico と macOS 用の build/icon.icns に詰める。
//
// どちらも純粋な Node の処理なので、実行している OS に関係なく**両方**を作る
// （Windows 機でも .icns が、mac でも .ico ができる。使われない側は置いてあるだけ）。
//
// 【この仕組みの要点】
// **画像を作らない。** サイズ変更も間引きも一切しない。
// 事前に用意した「そのサイズ専用に描かれた PNG」を、そのままの画素で .ico に格納するだけ。
//
// electron-builder に 1 枚の大きな PNG を渡すと、内部で機械的に縮小して全サイズを作る。
//
// 使い方:
//   npm run icon          … build/icon.ico と build/icon.icns を作り直す（dist の前段でも自動実行される）
//   npm run icon -- --check … 書き込まず、素材が揃っているかだけ検査する
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * .ico に入れるサイズ。Microsoft の推奨セット。
 *
 *   16  エクスプローラの「詳細」「一覧」、ジャンプリスト
 *   20  16 の 125% DPI 版
 *   24  タスクバー（100% DPI）
 *   32  デスクトップショートカット（100%）、Alt+Tab
 *   40  32 の 125% DPI 版
 *   48  エクスプローラ「中アイコン」（既定表示）
 *   64  48 の 133% DPI 版
 *  128  256 と 64 の中間。スケーリングの品質を稼ぐ
 *  256  「特大アイコン」。各所のスケーリング元
 *
 * ここに足したら build/icon/README.md の表にも足すこと。
 */
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/**
 * .icns に入れる枠（macOS）。`type` は ICNS の 4 文字の型で、PNG をそのまま格納できるもの。
 *
 * macOS は「表示サイズ（pt）× 倍率」で枠を持つので、同じ画素数の素材が 2 つの枠に入る
 * （32px は「32pt の 1x」と「16pt の 2x」の両方）。.ico に無い 20 / 24 / 40 / 48 の枠は無い。
 *
 *   16 / 32        メニューバー、Finder のリスト表示
 *   64             32pt の 2x
 *   128 / 256      Dock（Retina の Dock は最大 256px）、Finder のアイコン表示
 *   512 / 1024     Finder の大きなプレビュー、クイックルック
 *
 * `required: false` の素材は**あれば入れる**。無くてもアイコンとしては成立し、その大きさで
 * 表示される場面だけ 256px からの拡大になる。置けば次の `npm run icon` から入る。
 *
 * ここに足したら build/icon/README.md の表にも足すこと。
 */
const ICNS_ENTRIES = [
  { type: 'icp4', size: 16, required: true }, //   16pt 1x
  { type: 'ic11', size: 32, required: true }, //   16pt 2x
  { type: 'icp5', size: 32, required: true }, //   32pt 1x
  { type: 'ic12', size: 64, required: true }, //   32pt 2x
  { type: 'ic07', size: 128, required: true }, // 128pt 1x
  { type: 'ic13', size: 256, required: true }, // 128pt 2x
  { type: 'ic08', size: 256, required: true }, // 256pt 1x
  { type: 'ic14', size: 512, required: false }, // 256pt 2x
  { type: 'ic09', size: 512, required: false }, // 512pt 1x
  { type: 'ic10', size: 1024, required: false }, // 512pt 2x
];

/** .icns にだけ使う任意の素材（.ico には 256px を超えるものを格納できない）。 */
const OPTIONAL_SIZES = [...new Set(ICNS_ENTRIES.filter((e) => !e.required).map((e) => e.size))];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const root = resolve(import.meta.dirname, '..');
const sourceDir = resolve(root, 'build/icon');
const icoFile = resolve(root, 'build/icon.ico');
const icnsFile = resolve(root, 'build/icon.icns');
const checkOnly = process.argv.includes('--check');

/**
 * PNG のヘッダ（IHDR）だけを読む。
 *
 * IHDR は必ず先頭チャンクなので、固定オフセットで足りる
 * （8 バイトの署名 + 4 バイト長 + 4 バイト型 のあと、幅・高さ・ビット深度・カラータイプ）。
 */
function readPngHeader(bytes, label) {
  if (bytes.length < 26 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${label}: PNG ではありません`);
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
  };
}

/**
 * 素材を読み、サイズと形式が約束どおりかを検査する。1 つでも違えば止める。
 *
 * 必須の素材（SIZES）は欠けていたら止める。任意の素材（OPTIONAL_SIZES）は無ければ飛ばすが、
 * **置いてあるなら同じ検査を掛ける**（壊れた素材が黙って .icns に入るのを防ぐ）。
 */
function loadSources() {
  const loaded = [];
  const problems = [];

  for (const size of [...SIZES, ...OPTIONAL_SIZES]) {
    const file = resolve(sourceDir, `${String(size)}.png`);
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      if (SIZES.includes(size)) problems.push(`build/icon/${String(size)}.png がありません`);
      continue;
    }

    let header;
    try {
      header = readPngHeader(bytes, `build/icon/${String(size)}.png`);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    // ここで弾かないと、ファイル名と中身がずれた .ico ができて原因究明に時間を取られる。
    if (header.width !== size || header.height !== size) {
      problems.push(
        `build/icon/${String(size)}.png の実寸が ${String(header.width)}x${String(header.height)} です` +
          `（${String(size)}x${String(size)} でなければなりません）`,
      );
      continue;
    }
    // 32bit RGBA 以外は透過が欠けるか、OS 側で意図しない色になる。
    if (header.colorType !== 6 || header.bitDepth !== 8) {
      problems.push(
        `build/icon/${String(size)}.png は 8bit RGBA（colorType 6）で書き出してください` +
          `（現在: bitDepth ${String(header.bitDepth)} / colorType ${String(header.colorType)}）`,
      );
      continue;
    }

    loaded.push({ size, bytes });
  }

  if (problems.length > 0) {
    const lines = problems.map((p) => `  - ${p}`).join('\n');
    throw new Error(
      `アイコン素材に問題があります:\n${lines}\n` +
        `\n素材の置き場と作り方は build/icon/README.md を参照してください。`,
    );
  }
  return loaded;
}

/**
 * ICO を組み立てる。
 *
 * 構造は ICONDIR(6) + ICONDIRENTRY(16) × 枚数 + 画像データの並び。
 * 画像データは PNG のまま入れる（Windows Vista 以降が対応。対象は Win10/11 なので問題ない）。
 */
function buildIco(entries) {
  const headerSize = 6 + entries.length * 16;
  const directory = Buffer.alloc(headerSize);
  directory.writeUInt16LE(0, 0); // reserved
  directory.writeUInt16LE(1, 2); // type: 1 = icon
  directory.writeUInt16LE(entries.length, 4);

  let offset = headerSize;
  entries.forEach((entry, index) => {
    const at = 6 + index * 16;
    // 256 は 1 バイトに収まらないので 0 で表す（ICO の仕様）。
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, at);
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, at + 1);
    directory.writeUInt8(0, at + 2); // パレット数（true color なので 0）
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // color planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.bytes.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.bytes.length;
  });

  return Buffer.concat([directory, ...entries.map((e) => e.bytes)]);
}

/**
 * ICNS を組み立てる。
 *
 * 構造は 'icns' + 全体の長さ(4, BE) のあとに、型(4) + 長さ(4, BE。この 8 バイトを含む) + データ
 * の並び。データは PNG のまま入れる（ここで使う型はすべて PNG 格納に対応している）。
 * ICO と違って数値はビッグエンディアン。
 */
function buildIcns(entries) {
  const chunks = entries.map((entry) => {
    const header = Buffer.alloc(8);
    header.write(entry.type, 0, 'ascii');
    header.writeUInt32BE(entry.bytes.length + 8, 4);
    return Buffer.concat([header, entry.bytes]);
  });
  const body = Buffer.concat(chunks);

  const fileHeader = Buffer.alloc(8);
  fileHeader.write('icns', 0, 'ascii');
  fileHeader.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([fileHeader, body]);
}

let sources;
try {
  sources = loadSources();
} catch (error) {
  process.stderr.write(`[icon] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

if (checkOnly) {
  process.stdout.write(`[icon] 素材 ${String(sources.length)} 枚は揃っています（書き込みなし）\n`);
  process.exit(0);
}

const bySize = new Map(sources.map((s) => [s.size, s.bytes]));
const report = (file, sizes, bytes) => {
  process.stdout.write(`[icon] ${file} <- ${sizes.map(String).join(' / ')}\n`);
  process.stdout.write(`[icon]   ${String(sizes.length)} 枚 / ${(bytes.length / 1024).toFixed(1)} KB\n`);
};

mkdirSync(resolve(root, 'build'), { recursive: true });

// Windows: .ico（256px まで。それより大きい任意の素材は入れない）
const icoEntries = sources.filter((s) => SIZES.includes(s.size));
const ico = buildIco(icoEntries);
writeFileSync(icoFile, ico);
report('build/icon.ico', icoEntries.map((e) => e.size), ico);

// macOS: .icns（素材のある枠だけを入れる）
const icnsEntries = ICNS_ENTRIES.filter((e) => bySize.has(e.size)).map((e) => ({
  type: e.type,
  size: e.size,
  bytes: bySize.get(e.size),
}));
const icns = buildIcns(icnsEntries);
writeFileSync(icnsFile, icns);
report('build/icon.icns', icnsEntries.map((e) => e.size), icns);

const missing = OPTIONAL_SIZES.filter((size) => !bySize.has(size));
if (missing.length > 0) {
  process.stdout.write(
    `[icon]   任意の素材 ${missing.map((s) => `${String(s)}.png`).join(' / ')} が無いため、` +
      `その大きさでは 256px からの拡大表示になります（build/icon/README.md）\n`,
  );
}
