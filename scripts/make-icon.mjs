// build/icon.png（原画）からアプリアイコン build/icon-app.png を生成する。
//
// 原画には 2 つの問題があるため、そのままでは Windows のアイコンに向かない。
//   1. 背景が不透明な白 → ダークなタスクバーで白い四角に見える
//   2. 正方形でない（577x587） → electron-builder が .ico 生成時に引き伸ばす
//
// このスクリプトは以下を行う。原画は一切変更しない。
//   - 画像の縁から連結している白だけを透過にする（フラッドフィル）。
//     羽根の内側にある白いノードや軸は縁と繋がっていないので残る。
//   - アンチエイリアスのために、白さに応じてアルファを段階的に落とす。
//   - 正方形になるよう透過で余白を足す（拡大縮小しないので劣化しない）。
//
// 依存ライブラリは使わない（zlib は Node 標準）。
import { deflateSync, inflateSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 縁から辿るときに「白」と見なす下限。これ未満なら絵の一部として残す。 */
const FLOOD_MIN = 200;
/** 完全な透明になる明るさ。FLOOD_MIN から 255 へ向けてアルファを 255 -> 0 に落とす。 */
const FLOOD_MAX = 255;

function crcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}

const CRC = crcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('PNG ではありません');
  const chunks = [];
  let offset = 8;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

/** 8bit RGBA の PNG を復号して { width, height, pixels } を返す。 */
function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (ihdr === undefined) throw new Error('IHDR がありません');

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];

  if (bitDepth !== 8) throw new Error(`bitDepth 8 のみ対応（実際: ${String(bitDepth)}）`);
  if (colorType !== 6) throw new Error(`colorType 6 (RGBA) のみ対応（実際: ${String(colorType)}）`);
  if (interlace !== 0) throw new Error('インターレース PNG は非対応');

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = inflateSync(idat);

  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev === null ? 0 : prev[x];
      const c = prev === null || x < bpp ? 0 : prev[x - bpp];
      let value = line[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          value += a;
          break;
        case 2:
          value += b;
          break;
        case 3:
          value += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`未知のフィルタ種別: ${String(filter)}`);
      }
      out[x] = value & 0xff;
    }
  }

  return { width, height, pixels };
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** 8bit RGBA を PNG（フィルタなし）へ符号化する。 */
function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 画像の縁から連結している白を透過にする。
 *
 * 4 近傍のフラッドフィルなので、羽根の内側にある白いノードや軸は
 * 縁と繋がっていないため残る（一律の白抜きだと消えてしまう）。
 * アンチエイリアス部分は白さに応じてアルファを落とし、白い縁取りが出ないようにする。
 */
function removeBorderWhite(width, height, pixels) {
  const visited = new Uint8Array(width * height);
  const stack = [];

  const minChannel = (index) => {
    const o = index * 4;
    return Math.min(pixels[o], pixels[o + 1], pixels[o + 2]);
  };

  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (visited[index] === 1) return;
    if (minChannel(index) < FLOOD_MIN) return;
    visited[index] = 1;
    stack.push(index);
  };

  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }

  let cleared = 0;
  while (stack.length > 0) {
    const index = stack.pop();
    const x = index % width;
    const y = (index - x) / width;

    // 白さ FLOOD_MIN -> アルファ 255、白さ 255 -> アルファ 0 の直線で落とす
    const whiteness = minChannel(index);
    const ratio = (whiteness - FLOOD_MIN) / (FLOOD_MAX - FLOOD_MIN);
    const alpha = Math.max(0, Math.min(255, Math.round(255 * (1 - ratio))));
    pixels[index * 4 + 3] = alpha;
    if (alpha === 0) cleared += 1;

    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }

  return { visited: stack.length, cleared, touched: visited.reduce((n, v) => n + v, 0) };
}

/** 拡大縮小せず、透過の余白を足して正方形にする。 */
function padToSquare(width, height, pixels) {
  const size = Math.max(width, height);
  if (size === width && size === height) return { size, pixels };

  const out = Buffer.alloc(size * size * 4);
  const offsetX = Math.floor((size - width) / 2);
  const offsetY = Math.floor((size - height) / 2);

  for (let y = 0; y < height; y += 1) {
    const from = y * width * 4;
    const to = ((y + offsetY) * size + offsetX) * 4;
    pixels.copy(out, to, from, from + width * 4);
  }

  return { size, pixels: out };
}

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(root, 'build/icon.png');
const outputPath = resolve(root, 'build/icon-app.png');

if (!existsSync(sourcePath)) {
  // 原画が無い状態（土台だけを流用した直後など）では何もしない
  process.stdout.write('[icon] build/icon.png が無いのでスキップします' + String.fromCharCode(10));
  process.exit(0);
}

const source = await readFile(sourcePath);
const { width, height, pixels } = decodePng(source);
process.stdout.write(`原画: ${String(width)}x${String(height)}\n`);

const stats = removeBorderWhite(width, height, pixels);
process.stdout.write(
  `縁から連結した白を透過: ${String(stats.touched)} px（完全透過 ${String(stats.cleared)} px）\n`,
);

const squared = padToSquare(width, height, pixels);
process.stdout.write(`正方形化: ${String(squared.size)}x${String(squared.size)}（拡大縮小なし）\n`);

await writeFile(outputPath, encodePng(squared.size, squared.size, squared.pixels));
process.stdout.write(`出力: ${outputPath}\n`);
