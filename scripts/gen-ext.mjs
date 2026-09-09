#!/usr/bin/env node
// Generates src/manifest.json (+ static rulesets) for the Chrome extension,
// dogfooding src/ext/dnr-rules.mjs. Rerun after changing rules or the key.
// The unpacked extension root is src/. The Firefox manifest comes from the
// same source (scripts/lib/manifest.mjs) via scripts/pack-firefox.mjs.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { catchallRules } from '../src/ext/dnr-rules.mjs';
import { chromeManifest } from './lib/manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../src');

// Pinned id from the shared dev key (same key as the probe extension —
// they are never loaded into the same profile).
const key = readFileSync(join(HERE, '../test/fixtures/probe-ext/key.b64'), 'utf8').trim();
const hash = createHash('sha256').update(Buffer.from(key, 'base64')).digest();
let id = '';
for (const b of hash.subarray(0, 16))
  id += String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15));
const VIEWER = `chrome-extension://${id}/ext/viewer.html`;

mkdirSync(join(SRC, 'rules'), { recursive: true });
writeFileSync(
  join(SRC, 'rules/catchall.json'),
  JSON.stringify(catchallRules(VIEWER), null, 1) + '\n',
);

const manifest = chromeManifest(key);

writeFileSync(join(SRC, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`generated src/manifest.json (id ${id})`);
