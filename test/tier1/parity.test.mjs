// Headless parity for our stack (open-questions #19): extensions, DNR
// main_frame redirect, manifest COOP/COEP (SAB/threads), host-resolver-rules —
// all must behave in headless Chromium as they do headed, or CI is impossible.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, extensionIdFromManifest, oracleClear, oracleRequests } from '../harness/launch.mjs';
import { ensureFixtureServer } from '../harness/fixture-server.mjs';

const PROBE_EXT = join(dirname(fileURLToPath(import.meta.url)), '../../spikes/probe-ext');

let server, browser, context, extId;

before(async () => {
  server = await ensureFixtureServer();
  browser = await launch({ extensionDir: PROBE_EXT });
  context = browser.context;
  extId = extensionIdFromManifest(PROBE_EXT);
}, { timeout: 30000 });

after(async () => {
  await browser?.close();
  await server?.stop();
});

test('host-resolver-rules: https and http mappings both work', async () => {
  const page = await context.newPage();
  await page.goto('https://grid.bstest/');
  assert.ok((await page.content()).includes('BSTEST-GRID-SENTINEL'), 'https fixture');
  await page.goto('http://plain-http.bstest/');
  assert.ok((await page.content()).includes('BSTEST-GENERIC-SENTINEL'), 'http fixture');
  await page.close();
});

test('extension pages exist and are crossOriginIsolated with working SAB/Atomics', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/viewer.html`);
  const iso = await page.evaluate(() => globalThis.__probe.isolation());
  assert.equal(iso.crossOriginIsolated, true, 'crossOriginIsolated');
  assert.equal(iso.sabOk, true, 'SharedArrayBuffer');
  assert.equal(iso.wasmSharedMemOk, true, 'shared WebAssembly.Memory');
  assert.equal(iso.workerAtomicsOk, true, 'worker + Atomics round-trip');
  await page.close();
});

test('DNR main_frame redirect fires before any target fetch', async () => {
  await oracleClear();
  const page = await context.newPage();
  await page.goto('https://site-a.bstest/some/path?a=1&b=2');
  assert.ok(
    page.url().startsWith(`chrome-extension://${extId}/viewer.html?url=`),
    `landed on viewer, got ${page.url()}`,
  );
  const captured = await page.evaluate(() => globalThis.__probe.interceptedUrl());
  assert.equal(captured, 'https://site-a.bstest/some/path?a=1&b=2');
  // The invariant: zero target-site bytes fetched by the top-level browser.
  const reqs = await oracleRequests();
  assert.deepEqual(
    reqs.filter((r) => r.host.startsWith('site-a')),
    [],
    'no request for the intercepted site reached the wire',
  );
  await page.close();
});

test('non-listed domains are not intercepted', async () => {
  const page = await context.newPage();
  await page.goto('https://grid.bstest/');
  assert.equal(page.url(), 'https://grid.bstest/');
  await page.close();
});
