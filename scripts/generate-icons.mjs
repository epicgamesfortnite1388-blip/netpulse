#!/usr/bin/env node
/**
 * Generate the NetPulse icon set into src-tauri/icons/ using only Node built-ins.
 *
 * Visual identity: dark navy disc, teal "network pulse" mark — a heartbeat line
 * crossing a ring (monitoring + VPN tunnel). Rendered as raw RGBA pixels and
 * encoded to PNG (zlib via node:zlib) and ICO (PNG-in-ICO format).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src-tauri', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const BG = [11, 15, 23, 255]; // #0b0f17 dark navy
const FG = [45, 212, 191, 255]; // teal-400 pulse
const FG_DIM = [45, 212, 191, 90];
const RING = [148, 163, 184, 200]; // slate-400 ring

function drawIcon(size) {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = size * 0.44; // disc radius
  const ringR = size * 0.30; // pulse ring radius
  const ringW = Math.max(1, size * 0.035);
  // heartbeat line: flat - spike up - flat - dip - flat across the middle band
  const midY = cy;
  const spikeX = cx - size * 0.10;
  const spikeH = size * 0.16;
  const dipX = cx + size * 0.12;
  const dipH = size * 0.09;
  const lineW = Math.max(1, size * 0.045);

  const rgba = Buffer.alloc(size * size * 4);

  const dist = (x, y, x1, y1, x2, y2) => {
    // distance from point to segment
    const dx = x2 - x1;
    const dy = y2 - y1;
    const l2 = dx * dx + dy * dy || 1;
    let t = ((x - x1) * dx + (y - y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    return Math.hypot(x - px, y - py);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dc = Math.hypot(x - cx, y - cy);

      // rounded-square background with 1px anti-aliased edge
      let color = [0, 0, 0, 0];
      if (dc <= r) {
        color = [...BG];
      } else {
        rgba[i + 3] = 0;
        continue;
      }

      // outer ring
      if (Math.abs(dc - ringR) <= ringW) color = [...RING];
      // heartbeat: baseline + spike + dip
      const baseline = dist(x, y, cx - size * 0.28, midY, cx + size * 0.28, midY);
      const spike = dist(x, y, spikeX, midY, cx - size * 0.02, midY - spikeH);
      const fall = dist(x, y, cx - size * 0.02, midY - spikeH, cx + size * 0.05, midY);
      const dip = dist(x, y, cx + size * 0.05, midY, dipX, midY + dipH);
      const tail = dist(x, y, dipX, midY + dipH, cx + size * 0.28, midY);
      const pulseDist = Math.min(baseline, spike, fall, dip, tail);
      if (pulseDist <= lineW) color = [...FG];

      // inner dot in ring gap (tunnel node)
      const dot = Math.hypot(x - (cx + ringR), y - (cy - ringR));
      if (dot <= size * 0.045) color = [...FG_DIM];

      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = color[3];
    }
  }
  return rgba;
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // raw: filter byte 0 per row
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = { '32x32.png': 32, '128x128.png': 128, '128x128@2x.png': 256, 'icon.png': 512 };
for (const [name, s] of Object.entries(sizes)) {
  fs.writeFileSync(path.join(outDir, name), encodePng(drawIcon(s), s));
  console.log(`icon: ${name} (${s}px)`);
}

// ICO: classic 32bpp BMP-DIB entries (32/48/256). PNG-in-ICO is valid on
// Vista+ but some resource compilers (windres via tauri-winres) and older
// shell components are strict; uncompressed DIB entries are universally
// accepted and also fix the earlier malformed header (4-byte header made
// Windows parse the file as a cursor).
function bmpDibEntry(rgba, size) {
  // BITMAPINFOHEADER (40 bytes); biHeight counts XOR + AND rows.
  const xorRow = size * 4;
  const andRow = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(xorRow * size + andRow * size, 20); // biSizeImage

  // XOR mask: BGRA, bottom-up.
  const xor = Buffer.alloc(xorRow * size);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = (srcY * size + x) * 4;
      const d = y * xorRow + x * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }
  // AND mask: all opaque (alpha channel governs transparency).
  const and = Buffer.alloc(andRow * size);
  return Buffer.concat([header, xor, and]);
}

const icoSizes = [32, 48, 256];
const dibs = icoSizes.map((s) => ({ w: s, dib: bmpDibEntry(drawIcon(s), s) }));
const headerSize = 6 + dibs.length * 16;
const dirs = [];
let offset = headerSize;
for (const e of dibs) {
  const dir = Buffer.alloc(16);
  dir[0] = e.w >= 256 ? 0 : e.w; // width (0 = 256)
  dir[1] = e.w >= 256 ? 0 : e.w; // height (0 = 256)
  dir[2] = 0; // color count
  dir[3] = 0; // reserved
  dir.writeUInt16LE(1, 4); // planes
  dir.writeUInt16LE(32, 6); // bit count
  dir.writeUInt32LE(e.dib.length, 8); // bytes in resource
  dir.writeUInt32LE(offset, 12); // image offset
  dirs.push(dir);
  offset += e.dib.length;
}
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0); // reserved
icoHeader.writeUInt16LE(1, 2); // type = icon (1)
icoHeader.writeUInt16LE(dibs.length, 4); // image count
fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([icoHeader, ...dirs, ...dibs.map((d) => d.dib)]));
console.log(`icon: icon.ico (${icoSizes.join('/')}, 32bpp BMP)`);

// ICNS placeholder for macOS builds (real ICNS built by Tauri on macOS CI)
console.log('done.');
