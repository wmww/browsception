// Tier 0 — the release archives (scripts/lib/zip.mjs). Hand-rolled binary
// format with nothing else checking it: a wrong offset or CRC ships as a
// corrupt .zip/.xpi that only the store's uploader rejects. Verified against
// an INDEPENDENT implementation (`unzip`), not our own reader.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '../../scripts/lib/zip.mjs';

const has = (bin) => {
  try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
};

const dir = mkdtempSync(join(tmpdir(), 'bs-zip-'));
mkdirSync(join(dir, 'sub'));
const files = {
  // compressible, incompressible (the store path), empty, nested
  'text.js': 'x'.repeat(50000),
  'random.bin': Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 2654435761) & 0xff)),
  'empty.txt': '',
  'sub/deep.mjs': '// deep\n',
};
for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
const entries = Object.keys(files).map((name) => ({ name, source: join(dir, name) }));

test('writeZip round-trips through an independent unzip', { skip: has('unzip') ? false : 'no unzip' },
  async () => {
    const zip = join(dir, 'out.zip');
    const { entries: n } = await writeZip(zip, entries);
    assert.equal(n, entries.length);
    execFileSync('unzip', ['-t', zip], { stdio: 'ignore' }); // throws on CRC/offset damage
    const out = join(dir, 'x');
    execFileSync('unzip', ['-q', zip, '-d', out]);
    for (const [name, body] of Object.entries(files))
      assert.deepEqual(readFileSync(join(out, name)), Buffer.from(body), name);
  });

test('writeZip is deterministic', async () => {
  const a = join(dir, 'a.zip'), b = join(dir, 'b.zip');
  await writeZip(a, entries);
  await writeZip(b, [...entries].reverse()); // order of the input must not matter
  assert.deepEqual(readFileSync(a), readFileSync(b));
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
