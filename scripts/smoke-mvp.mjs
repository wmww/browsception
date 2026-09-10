#!/usr/bin/env node
// Phase-2 / MVP exit-gate runner: the SHIPPING DEFAULT (active, whitelist
// mode, empty whitelist, catch-all installed) against REAL SITES.
// Fresh profile, zero stored state — exactly a new install. Verifies:
//   1. an omnibox-style navigation to any http(s) URL lands in the viewer
//      and renders/executes nested (probe pixel + nested title -> tab title),
//   2. a second real site does the same concurrently,
//   3. whitelisting a domain sweeps its open viewer tab native and makes
//      fresh navigations native, while unlisted tabs stay sandboxed.
// REAL SITES — manual/agent smoke only (notes/testing.md), never CI, run
// sparingly. Usage: node scripts/smoke-mvp.mjs [--headed]

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, extensionId } from '../test/harness/launch.mjs';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '../src');
const headed = process.argv.includes('--headed');

const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`);
let failures = 0;
const check = (ok, s) => {
  if (ok) log(`ok   ${s}`);
  else {
    console.log(`FAIL ${s}`);
    failures++;
  }
};

async function poll(fn, what, timeoutMs = 60000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout: ${what} (last: ${JSON.stringify(last)})`);
}

const session = await launch({ extensionDir: EXT, headless: !headed, needsEngine: true });
const { context } = session;
const EXT_ID = await extensionId(session.context);
const VIEWER_PREFIX = `chrome-extension://${EXT_ID}/ext/viewer.html?url=`;

async function configure(patch) {
  const cfg = await context.newPage();
  await cfg.goto(`chrome-extension://${EXT_ID}/ext/viewer.html?stub=1`);
  await cfg.evaluate((p) => chrome.storage.sync.set(p), patch);
  await cfg.close();
}

try {
  // --- 1. fresh-install omnibox navigation -> nested render ---------------
  const ex = await context.newPage();
  await ex.goto('https://example.com/');
  check(ex.url().startsWith(VIEWER_PREFIX), `default posture intercepts example.com: ${ex.url()}`);
  await ex.waitForFunction(() => globalThis.__bs?.ready, undefined, { timeout: 120000 });
  await poll(
    () => ex.evaluate(() => __bs.state.url === 'https://example.com/'),
    'engine committed example.com',
    120000,
  );
  await poll(async () => (await ex.title()) === 'Example Domain', 'nested title -> tab title', 60000);
  log('ok   example.com committed + nested title reached the tab');
  // example.com body background is #eee (as of 2026-08) — a rendered-pixel
  // sanity probe; adjust if the live site restyles.
  const px = await poll(
    async () => {
      const p = await ex.evaluate(() => __bs.probe(10, 10));
      return p && p[0] === 238 && p[1] === 238 && p[2] === 238 ? p : null;
    },
    'nested render probe',
    60000,
  );
  log(`ok   nested render probe @10,10 = [${px}]`);

  // --- 2. a second real site, concurrently --------------------------------
  const wp = await context.newPage();
  await wp.goto('https://en.wikipedia.org/');
  check(wp.url().startsWith(VIEWER_PREFIX), `wikipedia intercepted: ${wp.url()}`);
  await wp.waitForFunction(() => globalThis.__bs?.ready, undefined, { timeout: 120000 });
  await poll(async () => (await wp.title()).includes('Wikipedia'), 'wikipedia nested title', 180000);
  log('ok   wikipedia rendered nested (title reached the tab)');

  // --- 3. whitelisting a domain makes it native again ----------------------
  await configure({ whitelist: ['example.com'] });
  await poll(() => ex.url() === 'https://example.com/', 'open viewer tab swept native', 30000);
  log('ok   whitelist edit swept the open example.com viewer tab native');
  check(wp.url().startsWith(VIEWER_PREFIX), 'unlisted wikipedia tab stays sandboxed');
  const fresh = await context.newPage();
  await fresh.goto('https://example.com/');
  check(fresh.url() === 'https://example.com/', `fresh navigation is native: ${fresh.url()}`);
  await fresh.close();
  await wp.close();
  await ex.close();
} catch (e) {
  console.log(`FAIL ${e.message}`);
  failures++;
} finally {
  await session.close();
}

console.log(failures === 0 ? 'MVP GATE PASS' : `MVP GATE FAIL (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
