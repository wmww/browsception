// Tier 0 — the permission surface. Every entry is an install warning or a
// store-review question, so adding one must be a visible diff here, not a
// side effect of a feature (notes/extension-platform.md § Permissions).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeManifest, firefoxManifest } from '../../scripts/lib/manifest.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../src');

const PERMISSIONS = ['declarativeNetRequestWithHostAccess', 'storage', 'tabs', 'webRequest'];
const HOST_PERMISSIONS = ['<all_urls>'];

for (const [name, manifest] of [['chrome', chromeManifest()], ['firefox', firefoxManifest()]]) {
  test(`${name} manifest requests exactly the intended permissions`, () => {
    assert.deepEqual([...manifest.permissions].sort(), PERMISSIONS);
    assert.deepEqual(manifest.host_permissions, HOST_PERMISSIONS);
    assert.equal(manifest.optional_permissions, undefined);
    assert.equal(manifest.optional_host_permissions, undefined);
  });
}

test('src/manifest.json is regenerated (node scripts/gen-ext.mjs)', () => {
  const onDisk = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
  assert.deepEqual(onDisk, chromeManifest());
});
