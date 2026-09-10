// Minimal zip writer — no npm dep, no `zip` binary on the build host.
//
// Deterministic: entries sorted, fixed 1980-01-01 DOS timestamps, fixed
// permissions, so identical inputs give a byte-identical archive (a release
// artifact you can diff against the last one).
//
// Plain zip32, sizes known before each local header (we compress in memory).
// Fine for our shape: a few hundred files, one 100 MB member, ~40 MB out —
// nothing near the 4 GB point where zip64 would be required.

import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { crc32, deflateRawSync } from 'node:zlib';

const DOS_TIME = 0, DOS_DATE = 0x0021; // 1980-01-01 00:00:00
const UTF8_NAMES = 1 << 11;            // general-purpose flag bit 11
const UNIX_0644 = (0o100644 << 16) >>> 0;

/**
 * @param {string} outPath
 * @param {{name: string, source: string}[]} entries  name = path inside the
 *        archive (forward slashes), source = file to read.
 * @returns {Promise<{bytes: number, entries: number}>}
 */
export async function writeZip(outPath, entries) {
  const out = createWriteStream(outPath);
  const put = async (buf) => { if (!out.write(buf)) await once(out, 'drain'); };
  const central = [];
  let offset = 0;

  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const raw = await readFile(e.source);
    const deflated = deflateRawSync(raw);
    // Storing beats deflating on already-compressed or tiny members.
    const store = deflated.length >= raw.length;
    const body = store ? raw : deflated;
    const method = store ? 0 : 8;
    const crc = crc32(raw);
    const name = Buffer.from(e.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    await put(local);
    await put(name);
    await put(body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4);         // made by: unix, zip 3.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(UTF8_NAMES, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(UNIX_0644, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));
    offset += local.length + name.length + body.length;
  }

  const dir = Buffer.concat(central);
  await put(dir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  await put(eocd);

  out.end();
  await once(out, 'finish');
  return { bytes: offset + dir.length + eocd.length, entries: central.length };
}
