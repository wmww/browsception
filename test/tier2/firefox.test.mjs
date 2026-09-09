// Tier 2 — Firefox subset: the shared scenarios that prove the one source
// tree runs on both browsers (plans → notes/extension-platform.md § Firefox):
// boot + render, interception via the runtime-installed catch-all, a
// whitelist/blacklist reconcile, native handoff, scheme gates, crash reload.
// Drives headless system Firefox over WebDriver BiDi (test/harness/firefox.mjs)
// with the extension packed by scripts/pack-firefox.mjs (dist/firefox/, the
// Firefox manifest over hardlinks into src/). Skips when Firefox is absent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { launchFirefox, FIREFOX_BIN, oracleClear, oracleRequests } from '../harness/firefox.mjs';
import { waitForFixtureServer, requireStagedEngine } from '../harness/launch.mjs';
import { packFirefox } from '../../scripts/pack-firefox.mjs';

const skip = existsSync(FIREFOX_BIN) ? false : `no Firefox at ${FIREFOX_BIN} (BS_FIREFOX)`;
const BOOT_TIMEOUT = 120000;
const FIXTURE_BLACKLIST = ['grid.bstest', 'input.bstest', 'app.bstest', 'other.bstest', 'hostile.bstest'];

let fixtures, ff, VIEWER_BASE;
const viewerURL = (target, extra = '') => `${VIEWER_BASE}?${extra ? extra + '&' : ''}url=${target}`;

test.before(async () => {
  if (skip) return;
  requireStagedEngine(new URL('../../src', import.meta.url).pathname);
  const dist = packFirefox();
  fixtures = spawn('node', [new URL('../fixtures/server.mjs', import.meta.url).pathname], { stdio: 'ignore' });
  await waitForFixtureServer();
  ff = await launchFirefox({ extensionDir: dist });
  assert.ok(ff.extensionBaseUrl, 'extension UUID discovered');
  VIEWER_BASE = `${ff.extensionBaseUrl}ext/viewer.html`;
});
test.after(async () => {
  await ff?.close();
  fixtures?.kill();
});

// State edits go through a stub-viewer page like the Chrome suite's configure().
async function configure(patch, ready) {
  const cfg = await ff.newPage();
  await cfg.goto(`${VIEWER_BASE}?stub=1`);
  await cfg.evaluate((p) => chrome.storage.sync.set(p), patch);
  if (ready) await cfg.waitForFunction(ready, { timeout: 15000 });
  await cfg.close();
}
const catchallInstalled = `chrome.declarativeNetRequest.getDynamicRules().then((r) => r.some((x) => x.id === 1))`;
const catchallGone = `chrome.declarativeNetRequest.getDynamicRules().then((r) => !r.some((x) => x.id === 1))`;

async function bootViewer(target, extra = '') {
  const page = await ff.newPage();
  await page.goto(viewerURL(target, extra));
  await page.waitForFunction('globalThis.__bs?.ready === true', { timeout: BOOT_TIMEOUT });
  return page;
}
const probe = (page, x, y) => page.evaluate(([px, py]) => __bs.probe(px, py), [x, y]);
async function until(page, x, y, rgb, timeoutMs = 90000, what = 'probe') {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await probe(page, x, y);
    if (last && last[0] === rgb[0] && last[1] === rgb[1] && last[2] === rgb[2]) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${what} @${x},${y} stuck at [${last}]`);
}
async function pollUntil(fn, what, timeoutMs = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} (last: ${JSON.stringify(last)})`);
}

// Fresh install (whitelist mode, empty whitelist): the event page installs the
// catch-all as a DYNAMIC rule — Firefox cannot ship a static one because the
// moz-extension UUID is per profile. Until then nothing intercepts; the sweep
// is the backstop, exactly as for Chrome's startup race.
test('firefox: fresh install intercepts any http(s) navigation into the viewer', { skip, timeout: 300000 }, async () => {
  const cfg = await ff.newPage();
  await cfg.goto(`${VIEWER_BASE}?stub=1`);
  await cfg.waitForFunction(catchallInstalled, { timeout: 15000 });
  await cfg.close();
  await oracleClear();
  const page = await ff.newPage();
  await page.goto('https://other.bstest/');
  const url = await page.url();
  assert.ok(url.startsWith(VIEWER_BASE + '?url='), `redirected to viewer: ${url}`);
  assert.ok(url.endsWith('url=https://other.bstest/'), `raw url plumbed: ${url}`);
  const hits = (await oracleRequests()).filter((r) => r.host === 'other.bstest' && r.path === '/');
  assert.equal(hits.length, 0, 'no target bytes fetched natively');
  await page.close();
});

test('firefox: boot + render in the worker-hosted engine', { skip, timeout: 300000 }, async () => {
  await configure({ active: true, mode: 'blacklist', blacklist: FIXTURE_BLACKLIST, whitelist: [] }, catchallGone);
  const page = await bootViewer('https://grid.bstest/');
  await until(page, 100, 100, [255, 0, 0], 120000, 'grid paint');
  for (const [x, y, rgb] of [[300, 100, [0, 255, 0]], [100, 300, [0, 0, 255]], [300, 300, [255, 255, 0]]]) {
    const p = await probe(page, x, y);
    assert.deepEqual(p, rgb, `@${x},${y}`);
  }
  const st = await page.evaluate(() => ({ url: __bs.state.url, frames: __bs.frames, fb: __bs.fb, coi: crossOriginIsolated, sab: typeof SharedArrayBuffer }));
  assert.equal(st.url, 'https://grid.bstest/');
  assert.ok(st.frames > 0 && st.fb?.w > 0, `frames presented: ${JSON.stringify(st)}`);
  assert.equal(st.coi, false, 'Firefox extension pages are not cross-origin isolated (design premise)');
  await page.close();
});

// The bridge end to end on Firefox: engine JS + timers, same/cross-origin
// fetch through the bridge, the cookie round-trip (Set-Cookie captured via
// webRequest from the extension page, Cookie replayed via a DNR session rule),
// pushState mirrored into the tab URL, and an engine-driven redirect chain
// (3xx recovered from onHeadersReceived — Firefox has no onBeforeRedirect for
// a redirect:'error' fetch).
test('firefox: execute — app.bstest JS/timer/fetch/xfetch/cookie/pushState + redirect chain', { skip, timeout: 300000 }, async () => {
  const page = await bootViewer('https://app.bstest/');
  const SW = { JS: 25, TIMER: 75, FETCH: 125, XFETCH: 175, COOKIE: 225, PUSHSTATE: 275 };
  for (const [name, x] of Object.entries(SW)) await until(page, x, 425, [0, 255, 0], 120000, name);
  await pollUntil(async () => (await page.url()).endsWith('url=https://app.bstest/pushed'), 'tab URL follows guest pushState');
  await page.evaluate(() => __bs.eval("document.getElementById('redirlink').click()"));
  await pollUntil(() => page.evaluate(() => /^https:\/\/app\.bstest\/final\b/.test(__bs.state.url ?? '')), 'redirect chain landed', 60000);
  await page.close();
});

test('firefox: reconcile — blacklist edit sandboxes, whitelist edit runs natively', { skip, timeout: 300000 }, async () => {
  // blacklist posture from the previous test: input.bstest sandboxed
  let page = await ff.newPage();
  await page.goto('https://input.bstest/');
  assert.ok((await page.url()).startsWith(VIEWER_BASE), 'blacklisted domain sandboxed');
  await page.close();
  // whitelist mode with grid trusted: grid native (oracle sees it), input sandboxed by the catch-all
  await configure({ mode: 'whitelist', whitelist: ['grid.bstest'] }, catchallInstalled);
  await oracleClear();
  page = await ff.newPage();
  await page.goto('https://grid.bstest/');
  assert.equal(await page.url(), 'https://grid.bstest/', 'whitelisted domain runs natively');
  assert.ok((await oracleRequests()).some((r) => r.host === 'grid.bstest'), 'native load hit the fixture server');
  await page.close();
  page = await ff.newPage();
  await page.goto('https://input.bstest/');
  assert.ok((await page.url()).startsWith(VIEWER_BASE), 'unlisted domain sandboxed by the dynamic catch-all');
  await page.close();
});

test('firefox: boundary — nested navigation to a whitelisted domain hands the real tab the URL', { skip, timeout: 300000 }, async () => {
  // still whitelist mode, grid trusted
  const page = await bootViewer('https://input.bstest/');
  await until(page, 500, 100, [0, 0, 255], 120000, 'fixture render');
  await page.evaluate(() => __bs.eval("location.href = 'https://grid.bstest/'"));
  await pollUntil(async () => (await page.url()) === 'https://grid.bstest/', 'real tab went native', 60000);
  await page.close();
  await configure({ mode: 'blacklist', whitelist: [], blacklist: FIXTURE_BLACKLIST }, catchallGone);
});

test('firefox: scheme gates — a non-http(s) ?url= never boots the engine', { skip, timeout: 300000 }, async () => {
  for (const target of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
    const page = await ff.newPage();
    await page.goto(viewerURL(target));
    const strip = await pollUntil(
      () => page.evaluate(() => document.getElementById('boot').textContent),
      `blocked strip for ${target}`,
    );
    assert.match(strip, /only http\(s\) URLs/, `${target}: ${strip}`);
    assert.equal(await page.evaluate(() => !!globalThis.__bs), false, `${target}: engine never loaded`);
    assert.ok((await page.url()).startsWith(ff.extensionBaseUrl), `${target}: tab stays extension-origin`);
    await page.close();
  }
});

test('firefox: crash — engine abort -> crashed UI -> reload recovers', { skip, timeout: 300000 }, async () => {
  const page = await bootViewer('https://grid.bstest/');
  await until(page, 100, 100, [255, 0, 0], 120000, 'pre-crash paint');
  await page.evaluate(() => __bs.crash());
  await page.waitForFunction('globalThis.__bs?.dead === true', { timeout: 30000 });
  assert.match(await page.evaluate(() => document.getElementById('boot').textContent), /crashed/i);
  // Reload: the old worker is terminated on pagehide (Firefox reclaims dead
  // wasm instances lazily), and a fresh one boots.
  await page.evaluate(() => location.reload());
  await page.waitForFunction('globalThis.__bs?.ready === true', { timeout: BOOT_TIMEOUT });
  await until(page, 100, 100, [255, 0, 0], 120000, 'post-reload paint');
  await page.close();
});

// Bridge semantics only Firefox's network stack produces (tier-1 runs on
// Chrome); both through the stub engine, both green on Chrome by construction.
// 1. webRequest joins repeated headers with "\n": google.com's 8 Set-Cookie
//    lines arrived as one value and the engine refused the response.
// 2. An HSTS upgrade is onBeforeRedirect status 0 + the same fetch carrying on
//    to https; the bridge must hand the engine a 307 hop, not the target body
//    under the http URL — and never a bare network failure.
async function stubPage() {
  const page = await ff.newPage();
  await page.goto(`${VIEWER_BASE}?stub=1`);
  await page.waitForFunction('!!globalThis.__bs');
  return page;
}
const request = (page, req) => page.evaluate((r) => __bs.request(r), req);

test('firefox: repeated Set-Cookie reaches the engine one header per cookie', { skip, timeout: 120000 }, async () => {
  const page = await stubPage();
  const t = await request(page, { url: 'https://app.bstest/set-cookie?n=a&v=1&n=b&v=2' });
  assert.equal(t.status, 200);
  assert.deepEqual(t.headers.filter(([k]) => k === 'set-cookie').map(([, v]) => v), ['a=1; Path=/', 'b=2; Path=/']);
  await page.close();
});

test('firefox: an HSTS upgrade reaches the engine as a 307 hop it re-issues itself', { skip, timeout: 120000 }, async () => {
  if (!ff.trustsFixtureCert) {
    console.log('  skipped: certutil/fixture cert unavailable, Firefox will not honour HSTS');
    return;
  }
  const page = await stubPage();
  const seed = await request(page, { url: 'https://other.bstest/hsts' });
  assert.equal(seed.status, 200);
  assert.equal(Object.fromEntries(seed.headers)['strict-transport-security'], 'max-age=300');
  await oracleClear();
  const t = await request(page, { url: 'http://other.bstest/final', main: 1 });
  assert.deepEqual(t.events, ['redirect'], JSON.stringify(t));
  assert.equal(t.redirect.status, 307);
  assert.equal(Object.fromEntries(t.redirect.headers).location, 'https://other.bstest/final');
  assert.equal(await page.evaluate(() => __bs.mainFailures.length), 0, 'not a load failure');
  assert.deepEqual((await oracleRequests()).filter((r) => r.scheme === 'http'), [], 'nothing went out over http');
  // The engine issues the hop as its own request and gets the page.
  const hop = await request(page, { url: 'https://other.bstest/final', main: 1 });
  assert.equal(hop.status, 200);
  assert.ok(hop.bodyText.includes('REDIRECT-FINAL'));
  assert.equal(await page.evaluate(() => __bs.capturePending()), 0, 'no orphaned capture entries');
  await page.close();
});
