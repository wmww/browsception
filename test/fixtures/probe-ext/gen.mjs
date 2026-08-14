#!/usr/bin/env node
// Generates manifest.json + static DNR rulesets for the probe extension,
// dogfooding src/ext/dnr-rules.mjs. Rerun after changing key.b64 or rules.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryRegex, catchallRules, PRIORITY } from '../../src/ext/dnr-rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const key = readFileSync(join(HERE, 'key.b64'), 'utf8').trim();

// Pinned id derived from the key (see harness extensionIdFromManifest).
import { createHash } from 'node:crypto';
const hash = createHash('sha256').update(Buffer.from(key, 'base64')).digest();
let id = '';
for (const b of hash.subarray(0, 16))
  id += String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15));
const VIEWER = `chrome-extension://${id}/viewer.html`;

// Blacklist-mode static ruleset: hand-curated test domains (spike 0.3).
const BLACKLIST = ['site-a.bstest', 'site-b.bstest'];
writeFileSync(
  join(HERE, 'rules/blacklist.json'),
  JSON.stringify(
    BLACKLIST.map((entry, i) => ({
      id: 100 + i,
      priority: PRIORITY.LIST_REDIRECT,
      action: { type: 'redirect', redirect: { regexSubstitution: `${VIEWER}?url=\\0` } },
      condition: { regexFilter: entryRegex(entry), resourceTypes: ['main_frame'] },
    })),
    null,
    1,
  ),
);

// Whitelist-mode catch-all prototype (disabled by default; spike 0.3 enables
// it at runtime via updateEnabledRulesets).
writeFileSync(join(HERE, 'rules/catchall.json'), JSON.stringify(catchallRules(VIEWER), null, 1));

const manifest = {
  manifest_version: 3,
  name: 'browsception probe',
  version: '0.0.1',
  key,
  permissions: ['declarativeNetRequest', 'declarativeNetRequestFeedback', 'storage', 'tabs', 'webRequest'],
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'sw.js' },
  cross_origin_embedder_policy: { value: 'require-corp' },
  cross_origin_opener_policy: { value: 'same-origin' },
  web_accessible_resources: [
    { resources: ['viewer.html'], matches: ['<all_urls>'] },
  ],
  declarative_net_request: {
    rule_resources: [
      { id: 'blacklist', enabled: true, path: 'rules/blacklist.json' },
      { id: 'catchall', enabled: false, path: 'rules/catchall.json' },
    ],
  },
};
writeFileSync(join(HERE, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`probe-ext generated; id=${id}`);
