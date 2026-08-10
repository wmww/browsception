#!/usr/bin/env node
// Generates src/manifest.json (+ static rulesets) for the real extension,
// dogfooding src/ext/dnr-rules.mjs. Rerun after changing rules or the key.
// The extension root for unpacked loading is src/.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { catchallRules, CATCHALL_RULESET_ID } from '../src/ext/dnr-rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../src');

// Pinned id from the shared dev key (same key as the probe extension —
// they are never loaded into the same profile).
const key = readFileSync(join(HERE, '../spikes/probe-ext/key.b64'), 'utf8').trim();
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

const manifest = {
  manifest_version: 3,
  name: 'browsception',
  version: '0.1.0',
  description: 'Runs websites inside a nested wasm browser engine.',
  key,
  minimum_chrome_version: '124',
  permissions: ['declarativeNetRequest', 'webRequest', 'storage', 'tabs'],
  host_permissions: ['<all_urls>'],
  declarative_net_request: {
    rule_resources: [
      {
        id: CATCHALL_RULESET_ID,
        enabled: false, // whitelist mode goes live in 2.6
        path: 'rules/catchall.json',
      },
    ],
  },
  cross_origin_opener_policy: { value: 'same-origin' },
  cross_origin_embedder_policy: { value: 'require-corp' },
};

writeFileSync(join(SRC, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`generated src/manifest.json (id ${id})`);
