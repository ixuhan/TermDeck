// Generates the Tauri app icons without any image dependency.
// Draws a dark rounded tile with a "›_" prompt glyph.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };

  const radius = size * 0.22;
  const inTile = (x, y) => {
    const dx = Math.min(x, size - 1 - x);
    const dy = Math.min(y, size - 1 - y);
    if (dx >= radius || dy >= radius) return true;
    const cx = radius - dx;
    const cy = radius - dy;
    return Math.hypot(cx, cy) <= radius;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inTile(x, y)) set(x, y, 31, 35, 40);
    }
  }

  // chevron ">"
  const stroke = Math.max(2, Math.round(size * 0.075));
  const cx0 = size * 0.3;
  const cy0 = size * 0.36;
  const cw = size * 0.18;
  const ch = size * 0.15;
  for (let t = 0; t <= 1; t += 0.004) {
    const x = cx0 + cw * t;
    const y1 = cy0 + ch * t;
    const y2 = cy0 + ch * 2 - ch * t;
    for (let s = -stroke / 2; s <= stroke / 2; s++) {
      set(Math.round(x), Math.round(y1 + s), 88, 166, 255);
      set(Math.round(x), Math.round(y2 + s), 88, 166, 255);
    }
  }

  // underscore
  for (let x = Math.round(size * 0.54); x < Math.round(size * 0.76); x++) {
    for (let s = 0; s < stroke; s++) {
      set(x, Math.round(size * 0.69) + s, 230, 237, 243);
    }
  }

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function ico(pngBuf, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuf]);
}

const dir = path.resolve("src-tauri/icons");
fs.mkdirSync(dir, { recursive: true });

for (const size of [32, 128, 256]) {
  fs.writeFileSync(path.join(dir, size === 256 ? "128x128@2x.png" : `${size}x${size}.png`), png(size));
}
fs.writeFileSync(path.join(dir, "icon.png"), png(512));
fs.writeFileSync(path.join(dir, "icon.ico"), ico(png(256), 256));
console.log("icons written to", dir);
