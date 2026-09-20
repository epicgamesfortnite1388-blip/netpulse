/**
 * Minimal deterministic ZIP writer for the updater artifact.
 *
 * The archive MUST use method 0 (STORED), and this is not a size preference:
 * `tauri-plugin-updater` depends on the `zip` crate with
 * `default-features = false` and no features enabled (verified in
 * tauri-plugin-updater 2.11.0's Cargo.toml). With no decompression feature
 * compiled in, zip's reader maps method 8 to `CompressionMethod::Unsupported`
 * and refuses the archive outright — observed live on the installed exe as
 * "unsupported Zip archive: Compression method not supported" while the update
 * was being extracted. STORED is the one method that reads without a feature,
 * so it is the only method that can ship. The installer is already compressed
 * internally, so deflate saved ~10 KB of 36 MB — nothing worth a rejected update.
 *
 * The shape is deliberately boring: one top-level entry (the installer itself —
 * the updater scans the extraction dir for the first .exe), no directories, no
 * extra fields, no zip64, no data descriptor, sizes and CRC in both headers.
 * The DOS timestamp comes from the caller (the installer's own mtime), so
 * re-running the stage over the same installer yields identical bytes.
 */
import fs from 'node:fs';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const x of buf) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date/time from a JS Date (local time, 2-second granularity). */
function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * Write `entryName` (the raw bytes of `content`) into a STORED zip at `out`.
 * Returns the artifact's byte size.
 */
export function writeZipSingleStored(out, entryName, content, mtime) {
  const crc = crc32(content);
  const name = Buffer.from(entryName, 'utf8');
  if (name.includes('\\') || name.includes('/')) {
    throw new Error(`zip entry must be a bare file name, got: ${entryName}`);
  }
  const { time, date } = dosDateTime(mtime ?? new Date(0));

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18); // compressed == uncompressed for stored
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28); // no extra field

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8); // flags
  central.writeUInt16LE(0, 10); // method: stored
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30); // extra len
  central.writeUInt16LE(0, 32); // comment len
  central.writeUInt16LE(0, 34); // disk number
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(0, 42); // local header offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(1, 8); // entries (this disk)
  eocd.writeUInt16LE(1, 10); // entries total
  eocd.writeUInt32LE(46 + name.length, 12); // central size
  eocd.writeUInt32LE(30 + name.length + content.length, 16); // central offset
  eocd.writeUInt16LE(0, 20); // comment len

  fs.writeFileSync(out, Buffer.concat([local, name, content, central, name, eocd]));
  return 30 + name.length + content.length + 46 + name.length + 22;
}

/** Read back the fields the updater's zip reader depends on. Test/support aid. */
export function inspectZip(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip: bad local header');
  const nameLen = b.readUInt16LE(26);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: no EOCD');
  const cd = b.readUInt32LE(eocd + 16);
  return {
    bytes: b.length,
    entries: b.readUInt16LE(eocd + 10),
    name: b.slice(30, 30 + nameLen).toString('utf8'),
    method: b.readUInt16LE(8),
    flags: b.readUInt16LE(6),
    localCrc: b.readUInt32LE(14),
    localCompressed: b.readUInt32LE(18),
    localSize: b.readUInt32LE(22),
    centralMethod: b.readUInt16LE(cd + 10),
    centralCrc: b.readUInt32LE(cd + 16),
    centralSize: b.readUInt32LE(cd + 24),
    centralOffset: b.readUInt32LE(eocd + 16),
  };
}
