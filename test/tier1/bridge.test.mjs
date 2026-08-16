// Tier 1: bridge semantics with the stub engine (notes/testing.md item 5).
// Real fetch bridge + real DNR + real webRequest capture in the real
// extension (src/), fake WebKit. The oracle (fixture server request log)
// verifies what actually hit the wire.
import { test, before, after, beforeEach } from 'node:test';
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
import { NET_ERR } from '../../src/abi/abi.mjs';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '../../src');

let server, browser, context, extId, page;

const boot = (opts) => page.evaluate((o) => __bsBoot(o), opts ?? {});
const request = (req) => page.evaluate((r) => __bs.request(r), req);

before(async () => {
  server = await ensureFixtureServer();
  browser = await launch({ extensionDir: EXT });
  context = browser.context;
  extId = extensionIdFromManifest(EXT);
  page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ext/viewer.html?stub=1`);
  await page.waitForFunction(() => !!globalThis.__bs);
  // This suite tests bridge semantics, not interception: pin an
  // everything-native posture so its native control navigations stay native
  // (the shipping default is whitelist mode with the catch-all enabled).
  await page.evaluate(() => chrome.storage.sync.set({ mode: 'blacklist' }));
  await page.waitForFunction(() =>
    chrome.declarativeNetRequest.getEnabledRulesets().then((r) => !r.includes('catchall')),
  );
}, { timeout: 30000 });

after(async () => {
  await browser?.close();
  await server?.stop();
});

beforeEach(() => oracleClear());

test('plain GET: status, headers, exact body; UA rewritten; no leak headers on the wire', async () => {
  const t = await request({ url: 'https://app.bstest/api/data' });
  assert.deepEqual(t.events.at(-1), 'done');
  assert.equal(t.status, 200);
  assert.equal(t.bodyText, '{"data":"FETCH-PAYLOAD"}');
  assert.equal(t.bodyBytes, t.bodyText.length);
  assert.ok(t.headers.some(([k, v]) => k === 'content-type' && v.startsWith('application/json')));
  const [wire] = await oracleRequests();
  assert.equal(wire.headers['user-agent'], 'BrowsceptionBridge/0.1');
  assert.equal(wire.headers.cookie, undefined);
  assert.equal(wire.headers.origin, undefined, 'extension origin must not leak');
  assert.equal(wire.headers.referer, undefined, 'extension URL must not leak');
  assert.equal(
    Object.keys(wire.headers).find((h) => h.startsWith('sec-ch-ua')),
    undefined,
    'client hints stripped',
  );
});

test('engine-sent Cookie/Referer/Origin ride via per-request DNR rule; rule cleaned up', async () => {
  const t = await request({
    url: 'https://app.bstest/echo-headers',
    headers: [
      ['Cookie', 'bsjar=engine-value'],
      ['Referer', 'https://app.bstest/prev'],
      ['Origin', 'https://app.bstest'],
      ['X-Engine-Header', 'passes'],
    ],
  });
  assert.equal(t.status, 200);
  const wire = JSON.parse(t.bodyText);
  assert.equal(wire.cookie, 'bsjar=engine-value');
  assert.equal(wire.referer, 'https://app.bstest/prev');
  assert.equal(wire.origin, 'https://app.bstest');
  assert.equal(wire['x-engine-header'], 'passes');
  // Per-request session rule must be gone after the terminal event.
  const rules = await page.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  assert.deepEqual(
    rules.filter((r) => r.id >= 10000),
    [],
    'per-request rules cleaned up',
  );
});

test('POST body reaches the wire intact', async () => {
  const t = await request({
    url: 'https://app.bstest/echo-body',
    method: 'POST',
    headers: [['Content-Type', 'text/plain']],
    body: 'engine-post-payload-✓',
  });
  assert.equal(t.status, 200);
  assert.equal(JSON.parse(t.bodyText).text, 'engine-post-payload-✓');
});

test('Set-Cookie (incl. HttpOnly) is delivered to the engine on 200s', async () => {
  const t = await request({
    url: 'https://app.bstest/set-cookie?n=probe&v=42&attrs=%3B%20Path%3D%2F%3B%20HttpOnly',
  });
  assert.equal(t.status, 200);
  const sc = t.headers.filter(([k]) => k === 'set-cookie').map(([, v]) => v);
  assert.deepEqual(sc, ['probe=42; Path=/; HttpOnly']);
});

test('redirects are engine-driven: 3xx reported with Location + hop Set-Cookie, target never fetched', async () => {
  const t = await request({
    url: 'https://app.bstest/set-cookie?n=hop&v=2&then=https%3A%2F%2Fsite-b.bstest%2Ffinal',
  });
  assert.deepEqual(t.events, ['redirect']);
  assert.equal(t.redirect.status, 302);
  const h = Object.fromEntries(t.redirect.headers);
  assert.equal(h.location, 'https://site-b.bstest/final');
  assert.equal(h['set-cookie'], 'hop=2; Path=/');
  const reqs = await oracleRequests();
  assert.deepEqual(reqs.filter((r) => r.host.startsWith('site-b')), [], 'engine drives the hop');
  // The engine (stub) issues the next hop itself, as the real one will:
  const hop = await request({ url: 'https://site-b.bstest/final', headers: [['Cookie', 'hop=2']] });
  assert.equal(hop.status, 200);
  assert.ok(hop.bodyText.includes('REDIRECT-FINAL'));
});

test('stack-synthesized redirects (no response headers) reach the engine too', async () => {
  // HSTS upgrades and DNR redirects skip onHeadersReceived entirely — only
  // onBeforeRedirect fires. Capturing just the former turned every
  // http://<hsts-preloaded-host>/ load into a bare network failure.
  await page.evaluate(() =>
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [900],
      addRules: [
        {
          id: 900,
          priority: 100,
          action: { type: 'redirect', redirect: { url: 'https://site-b.bstest/final' } },
          condition: {
            urlFilter: '|https://app.bstest/synth-redirect|',
            resourceTypes: ['xmlhttprequest'],
          },
        },
      ],
    }),
  );
  try {
    const t = await request({ url: 'https://app.bstest/synth-redirect' });
    assert.deepEqual(t.events, ['redirect']);
    assert.ok(t.redirect.status >= 300 && t.redirect.status < 400, `status ${t.redirect.status}`);
    assert.equal(Object.fromEntries(t.redirect.headers).location, 'https://site-b.bstest/final');
    const reqs = await oracleRequests();
    assert.deepEqual(reqs.filter((r) => r.host.startsWith('site-b')), [], 'engine drives the hop');
  } finally {
    await page.evaluate(() =>
      chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [900] }),
    );
  }
});

test('host jar never rides the bridge (credentials:omit, structurally)', async () => {
  const native = await context.newPage();
  await native.goto('https://app.bstest/set-cookie?n=hostjar&v=secret');
  const echoNative = await native.evaluate(() =>
    fetch('/cookie-echo', { credentials: 'include' }).then((r) => r.json()),
  );
  assert.ok(echoNative.cookie?.includes('hostjar=secret'), 'host jar primed');
  await native.close();
  await oracleClear();
  const t = await request({ url: 'https://app.bstest/cookie-echo' });
  assert.equal(JSON.parse(t.bodyText).cookie, null);
});

test('guard denial: private-network request fails as GUARD and never hits the wire', async () => {
  const t = await request({ url: `http://127.0.0.1:${HTTP_PORT}/api/data` });
  assert.deepEqual(t.events, ['fail']);
  assert.equal(t.error.kind, NET_ERR.GUARD);
  assert.equal(t.error.message, 'private-network');
  const reqs = await oracleRequests();
  assert.deepEqual(reqs, [], 'blocked before fetch');
});

test('size cap aborts the stream with TOO_LARGE', async () => {
  await boot({ maxResponseBytes: 2 * 1024 * 1024 });
  const t = await request({ url: 'https://app.bstest/big' });
  assert.equal(t.events.at(-1), 'fail');
  assert.equal(t.error.kind, NET_ERR.TOO_LARGE);
  assert.ok(t.bodyBytes <= 4 * 1024 * 1024, 'aborted early');
  await boot({});
});

test('idle timeout fires on a stalled response', async () => {
  await boot({ idleTimeoutMs: 500 });
  const t = await request({ url: 'https://app.bstest/slow' });
  assert.equal(t.events.at(-1), 'fail');
  assert.equal(t.error.kind, NET_ERR.TIMEOUT);
  await boot({});
});

test('credit window: slow acks throttle the stream but it completes intact; no heap leaks', async () => {
  await boot({ windowBytes: 256 * 1024, stub: { ackDelayMs: 5 } });
  const t = await request({ url: 'https://app.bstest/big' });
  assert.equal(t.events.at(-1), 'done');
  assert.equal(t.bodyBytes, 64 * 1024 * 1024);
  assert.ok(
    t.metrics.maxUnacked <= 256 * 1024 + 64 * 1024,
    `window respected (maxUnacked=${t.metrics.maxUnacked})`,
  );
  assert.equal(t.liveAllocs, 0, 'every heap allocation was freed');
  await boot({});
}, { timeout: 60000 });

test('a failed TOP-LEVEL load is reported to the viewer; cancels and hops are not', async () => {
  // Nothing commits on a failed main-frame load — without this signal the
  // viewer sits on the boot page forever (issues/, the HSTS wedge symptom).
  const failures = () => page.evaluate(() => __bs.mainFailures.slice());
  const before = (await failures()).length;

  const dead = await request({ url: 'https://nxdomain.invalid/', main: 1 });
  assert.equal(dead.error.kind, NET_ERR.NETWORK);
  const guarded = await request({ url: `http://127.0.0.1:${HTTP_PORT}/api/data`, main: 1 });
  assert.equal(guarded.error.kind, NET_ERR.GUARD);
  // Subresource failures and cancelled loads must stay silent.
  await request({ url: 'https://nxdomain.invalid/sub.js' });
  const cancelled = await page.evaluate(async () => {
    const p = __bs.request({ url: 'https://app.bstest/slow', main: 1 });
    await new Promise((r) => setTimeout(r, 100));
    __bs.cancel(p.id);
    return p;
  });
  assert.equal(cancelled.error.kind, NET_ERR.CANCELLED);

  const got = (await failures()).slice(before);
  assert.deepEqual(
    got.map((f) => [f.url, f.kind]),
    [
      ['https://nxdomain.invalid/', NET_ERR.NETWORK],
      [`http://127.0.0.1:${HTTP_PORT}/api/data`, NET_ERR.GUARD],
    ],
  );
});

test('the native handoff is http(s)-only: other schemes die at the guard', async () => {
  // The sandbox->host crossing (viewer: location.replace on the REAL tab).
  // navigationPolicy is consulted before the guard, and shouldSandbox is
  // false for every non-http scheme, so without the precondition a guest
  // top-level ftp://, bsx:// or file:// load lands on the host browser.
  await boot({ nativeAll: true });
  const natives = () => page.evaluate(() => __bs.natives.slice());
  for (const url of ['file:///etc/passwd', 'ftp://app.bstest/x', 'bsx://evil/x', 'javascript:alert(1)']) {
    const t = await request({ url, main: 1 });
    assert.equal(t.error.kind, NET_ERR.GUARD, `${url} must fail at the guard`);
    assert.deepEqual(await natives(), [], `${url} must not reach the native handoff`);
  }
  // http(s) still takes the branch (cancelled engine-side, handed to the host).
  const ok = await request({ url: 'https://app.bstest/', main: 1 });
  assert.equal(ok.error.kind, NET_ERR.CANCELLED);
  assert.deepEqual(await natives(), ['https://app.bstest/']);
  // ...and only for TOP-LEVEL loads: a subresource is never a crossing.
  const sub = await request({ url: 'https://app.bstest/api/data' });
  assert.equal(sub.status, 200);
  assert.deepEqual(await natives(), ['https://app.bstest/']);
  await boot({});
});

test('every finished request leaves the capture queue empty', async () => {
  // Unclaimed entries would be handed to the next fetch of the same URL.
  await request({ url: 'https://app.bstest/set-cookie?n=a&v=1' });
  await request({ url: 'https://app.bstest/redirect?to=%2Ffinal' });
  await request({ url: 'https://nxdomain.invalid/' });
  await new Promise((r) => setTimeout(r, 900)); // let discard()'s waiter expire
  assert.equal(await page.evaluate(() => __bs.capturePending()), 0);
});

test('DNR bridge rules do not touch native traffic', async () => {
  const native = await context.newPage();
  await native.goto('https://grid.bstest/');
  await native.evaluate(() => fetch('/echo-headers').then((r) => r.json()));
  await native.close();
  const wire = (await oracleRequests()).filter((r) => r.path === '/echo-headers');
  assert.equal(wire.length, 1);
  assert.notEqual(wire[0].headers['user-agent'], 'BrowsceptionBridge/0.1');
  assert.ok(wire[0].headers['user-agent'].includes('Chrome'));
});
