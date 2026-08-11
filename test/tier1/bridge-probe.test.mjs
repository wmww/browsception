// Spike 0.2 graduated into tier 1: the platform behaviors the
// fetch bridge design rests on. If Chrome changes any of these, the bridge
// needs a design review — results table in notes/bridge-probe.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launch,
  extensionIdFromManifest,
  oracleClear,
  oracleRequests,
  HTTP_PORT,
} from '../harness/launch.mjs';
import { ensureFixtureServer } from '../harness/fixture-server.mjs';

const PROBE_EXT = join(dirname(fileURLToPath(import.meta.url)), '../../spikes/probe-ext');

let server, browser, context, extId, page;

before(async () => {
  server = await ensureFixtureServer();
  browser = await launch({ extensionDir: PROBE_EXT });
  context = browser.context;
  extId = extensionIdFromManifest(PROBE_EXT);
  page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/viewer.html`);
  await page.evaluate(() => {
    __probe.wrStart();
    __probe.wrStartErrors();
  });
}, { timeout: 30000 });

after(async () => {
  await browser?.close();
  await server?.stop();
});

test('extension fetch is CORS-exempt (no-CORS-header cross-origin read)', async () => {
  const r = await page.evaluate(() => __probe.fetchProbe('https://site-b.bstest/whatever'));
  assert.equal(r.ok, true);
  assert.ok(r.bodyPrefix.includes('BSTEST-GENERIC-SENTINEL'));
});

test("redirect:'manual' is opaque even for extensions (documented platform limit)", async () => {
  const r = await page.evaluate(() =>
    __probe.manualRedirect('https://app.bstest/redirect?to=%2Ffinal'),
  );
  // If this ever starts returning real status/Location, simplify the bridge!
  assert.equal(r.type, 'opaqueredirect');
  assert.equal(r.status, 0);
  assert.equal(r.location, null);
});

test("engine-driven redirects: redirect:'error' + webRequest captures the 3xx, next hop never fetched", async () => {
  await oracleClear();
  await page.evaluate(() => {
    __probe.wrEvents.length = 0;
    return __probe.fetchProbe(
      'https://app.bstest/set-cookie?n=hop&v=2&then=https%3A%2F%2Fsite-b.bstest%2Ffinal',
      { redirect: 'error' },
    );
  });
  await new Promise((r) => setTimeout(r, 300));
  const events = await page.evaluate(() => __probe.wrDump());
  const recv = events.find((e) => e.event === 'onHeadersReceived');
  assert.equal(recv.statusCode, 302);
  const hdr = (e, n) => e.responseHeaders?.filter((h) => h.name.toLowerCase() === n) ?? [];
  assert.equal(hdr(recv, 'location')[0]?.value, 'https://site-b.bstest/final');
  assert.equal(hdr(recv, 'set-cookie')[0]?.value, 'hop=2; Path=/');
  assert.ok(events.some((e) => e.event === 'onErrorOccurred' && e.error === 'net::ERR_ABORTED'));
  // The redirect target must never hit the wire — the engine drives hops.
  const reqs = await oracleRequests();
  assert.deepEqual(reqs.filter((r) => r.host.startsWith('site-b')), []);
});

test('Set-Cookie: invisible to fetch, fully visible (incl. HttpOnly) via webRequest extraHeaders', async () => {
  const r = await page.evaluate(() => {
    __probe.wrEvents.length = 0;
    return __probe.fetchProbe(
      'https://app.bstest/set-cookie?n=probe&v=42&attrs=%3B%20Path%3D%2F%3B%20HttpOnly',
    );
  });
  assert.deepEqual(r.getSetCookie, [], 'fetch cannot see Set-Cookie');
  assert.ok(!r.headers.some(([k]) => k === 'set-cookie'));
  await new Promise((r) => setTimeout(r, 300));
  const events = await page.evaluate(() => __probe.wrDump());
  const recv = events.find((e) => e.event === 'onHeadersReceived');
  const sc = recv.responseHeaders.filter((h) => h.name.toLowerCase() === 'set-cookie');
  assert.deepEqual(sc.map((h) => h.value), ['probe=42; Path=/; HttpOnly']);
});

test('DNR modifyHeaders rewrites forbidden headers on bridge fetches only', async () => {
  await page.evaluate((extId) =>
    __probe.dnr.updateDynamicRules({
      removeRuleIds: [500],
      addRules: [
        {
          id: 500,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'user-agent', operation: 'set', value: 'BS-Bridge-UA/1.0' },
              { header: 'cookie', operation: 'set', value: 'bsjar=engine-value' },
              { header: 'referer', operation: 'set', value: 'https://fake-referer.example/' },
              { header: 'origin', operation: 'set', value: 'https://fake-origin.example' },
              { header: 'x-bs-bridge', operation: 'remove' },
            ],
          },
          condition: { initiatorDomains: [extId], resourceTypes: ['xmlhttprequest'] },
        },
      ],
    }), extId);
  await oracleClear();
  await page.evaluate(() =>
    __probe.fetchProbe('https://app.bstest/echo-headers', { headers: { 'x-bs-bridge': 'm' } }),
  );
  // Scoping control: identical fetch from a plain web page.
  const native = await context.newPage();
  await native.goto('https://grid.bstest/');
  await native.evaluate(() =>
    fetch('/echo-headers', { headers: { 'x-bs-bridge': 'm' } }).then((r) => r.json()),
  );
  await native.close();
  const reqs = (await oracleRequests()).filter((r) => r.path === '/echo-headers');
  assert.equal(reqs.length, 2);
  const [bridge, plain] = reqs;
  assert.equal(bridge.headers['user-agent'], 'BS-Bridge-UA/1.0');
  assert.equal(bridge.headers.cookie, 'bsjar=engine-value');
  assert.equal(bridge.headers.referer, 'https://fake-referer.example/');
  assert.equal(bridge.headers.origin, 'https://fake-origin.example');
  assert.equal(bridge.headers['x-bs-bridge'], undefined, 'marker stripped');
  assert.notEqual(plain.headers['user-agent'], 'BS-Bridge-UA/1.0', 'native traffic untouched');
  assert.equal(plain.headers['x-bs-bridge'], 'm', 'native marker passes through');
  assert.equal(plain.headers.cookie, undefined, 'no cookie injected on native traffic');
  await page.evaluate(() => __probe.dnr.updateDynamicRules({ removeRuleIds: [500] }));
});

test("host cookie jar never rides bridge fetches (credentials:'omit' + omit ignores Set-Cookie)", async () => {
  // Give the host jar a real cookie for app.bstest via a native navigation.
  const native = await context.newPage();
  await native.goto('https://app.bstest/set-cookie?n=hostjar&v=secret');
  const echoNative = await native.evaluate(() =>
    fetch('/cookie-echo', { credentials: 'include' }).then((r) => r.json()),
  );
  assert.ok(echoNative.cookie?.includes('hostjar=secret'), 'host jar primed');
  await native.close();
  // Bridge fetch to the same origin must carry nothing.
  await oracleClear();
  const r = await page.evaluate(() => __probe.fetchProbe('https://app.bstest/cookie-echo'));
  assert.equal(JSON.parse(r.bodyPrefix).cookie, null);
  const reqs = await oracleRequests();
  assert.equal(reqs[0].headers.cookie, undefined);
});

test('platform grants extensions loopback access — our guard carries PNA alone (open-questions #7)', async () => {
  const r = await page.evaluate(
    (port) => __probe.fetchProbe(`http://127.0.0.1:${port}/__health`),
    HTTP_PORT,
  );
  assert.equal(r.ok, true, 'Chrome does not block extension→loopback; guard list must');
});
