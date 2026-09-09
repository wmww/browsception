#!/usr/bin/env node
// Generates manifest.json + static DNR rulesets for the Firefox probe
// extension (plans/one-engine-both-browsers.md phase 0), dogfooding
// src/ext/dnr-rules.mjs. Firefox's moz-extension UUID is per-profile, so the
// harness pins it via the extensions.webextensions.uuids pref (see
// tools/probe-firefox.mjs); the static catch-all below bakes that UUID in.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryRegex, catchallRules, PRIORITY } from '../../../src/ext/dnr-rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const GECKO_ID = 'probe@browsception.test';
export const UUID = '6f3e6a5a-7b1c-4c2b-9f0a-2e2d1c0b0a99';
export const VIEWER = `moz-extension://${UUID}/viewer.html`;

// Chrome probe's key: Firefox should ignore "key" (Chrome-only) — kept to
// record the install warning, if any.
const key = readFileSync(join(HERE, '../probe-ext/key.b64'), 'utf8').trim();

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
writeFileSync(join(HERE, 'rules/catchall.json'), JSON.stringify(catchallRules(VIEWER), null, 1));

const manifest = {
  manifest_version: 3,
  name: 'browsception firefox probe',
  version: '0.0.1',
  key,
  minimum_chrome_version: '120',
  browser_specific_settings: { gecko: { id: GECKO_ID, strict_min_version: '128.0' } },
  action: { default_title: 'ff-probe' },
  permissions: [
    'alarms',
    'declarativeNetRequest',
    'declarativeNetRequestWithHostAccess',
    'declarativeNetRequestFeedback',
    'storage',
    'tabs',
    'webRequest',
  ],
  host_permissions: ['<all_urls>'],
  background: { scripts: ['background.js'], type: 'module' },
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  cross_origin_embedder_policy: { value: 'require-corp' },
  cross_origin_opener_policy: { value: 'same-origin' },
  web_accessible_resources: [{ resources: ['viewer.html'], matches: ['<all_urls>'] }],
  declarative_net_request: {
    rule_resources: [
      { id: 'blacklist', enabled: true, path: 'rules/blacklist.json' },
      { id: 'catchall', enabled: true, path: 'rules/catchall.json' },
    ],
  },
};
writeFileSync(join(HERE, 'manifest.json'), JSON.stringify(manifest, null, 1));
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`probe-ext-firefox generated; uuid=${UUID}`);
