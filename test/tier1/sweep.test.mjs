// Tier 1: the SW's tab sweep against real Chromium tab state (real src/
// extension, no engine — assertions are on tab URLs only).
//
// The sweep is the only backstop for a navigation the DNR rules never saw
// (browser startup / install race, notes/security.md § startup race), and the
// racing tab is by definition MID-navigation: Chromium reports it as
// url:'about:blank' + pendingUrl:target. A local server that accepts the
// connection and never answers pins a tab in that state deterministically.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { launch, extensionIdFromManifest } from '../harness/launch.mjs';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '../../src');

let browser, context, extId, cfg, server, base;
const viewerPrefix = () => `chrome-extension://${extId}/ext/viewer.html?url=`;

// Never-answering + normal endpoints on 127.0.0.1 (no DNS, no TLS).
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/stall') return; // headers never sent: tab stays pre-commit
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end('<title>native</title>ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launch({ extensionDir: EXT });
  context = browser.context;
  extId = extensionIdFromManifest(EXT);
  cfg = await context.newPage();
  await cfg.goto(`chrome-extension://${extId}/ext/viewer.html?stub=1`);
}, { timeout: 30000 });

after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

const setState = (patch) => cfg.evaluate((p) => chrome.storage.sync.set(p), patch);
const tabs = () =>
  cfg.evaluate(async () =>
    (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url, pendingUrl: t.pendingUrl })));

async function pollUntil(fn, what, timeoutMs = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what} (last: ${JSON.stringify(last)})`);
}

test('sweep catches a tab whose navigation is still in flight', async () => {
  // Trust 127.0.0.1 so the navigation is allowed out natively, then start one
  // that never commits — the same state as a tab that beat rule registration:
  // request on the wire, no rule will ever re-evaluate it.
  await setState({ active: true, mode: 'whitelist', whitelist: ['127.0.0.1'], blacklist: [] });
  await pollUntil(
    () => cfg.evaluate(() => chrome.declarativeNetRequest.getDynamicRules().then((r) => r.length === 1)),
    'allow rule applied',
  );
  const victim = await context.newPage();
  victim.goto(`${base}/stall`).catch(() => {});
  const pending = await pollUntil(
    async () => (await tabs()).find((t) => t.pendingUrl === `${base}/stall`),
    'tab is pre-commit with the target as pendingUrl',
  );
  assert.equal(pending.url, 'about:blank', 'pre-commit tab.url is the placeholder, not the target');

  // Untrust it: the reconcile's sweep must pull the in-flight tab into the viewer.
  await setState({ whitelist: [] });
  await pollUntil(() => victim.url().startsWith(viewerPrefix()), 'in-flight tab swept into the viewer');
  assert.equal(victim.url(), `${viewerPrefix()}${base}/stall`, 'raw target plumbed');
  await victim.close();
});

// A reconcile's sweep re-navigates every tab whose disposition it cannot
// vouch for — including one that is still pre-commit, because it has no way
// to know the rules already caught that request (that ignorance IS the
// startup-race backstop). Landing on top of an in-flight navigation aborts
// it, even though the tab then goes exactly where the redirect was taking it.
// So assert on where the tab settles, never on the goto promise.
async function gotoSandboxed(page, url) {
  await page.goto(url).catch((e) => {
    if (!/ERR_ABORTED/.test(e.message)) throw e;
  });
  await pollUntil(() => page.url().startsWith(viewerPrefix()), `sandboxed: ${url}`);
}

test('sweep does not revoke the "open natively" escape hatch', async () => {
  await setState({ active: true, mode: 'blacklist', blacklist: ['127.0.0.1'], whitelist: [] });
  const page = await context.newPage();
  await gotoSandboxed(page, `${base}/ok`);

  const tabId = (await tabs()).find((t) => t.url.startsWith(viewerPrefix())).id;
  const res = await cfg.evaluate(
    ([tabId, url]) => chrome.runtime.sendMessage({ type: 'open-natively', tabId, url }),
    [tabId, `${base}/ok`],
  );
  assert.deepEqual(res, { ok: true });
  await pollUntil(() => page.url() === `${base}/ok`, 'tab went native');

  // Any later reconcile sweeps every tab; this one is native on a blacklisted
  // host and must stay that way (the session allow rule outranks the redirect).
  // An unrelated list edit is the trigger; the rule count proves it landed.
  await setState({ blacklist: ['127.0.0.1', 'unrelated.example'] });
  await pollUntil(
    () => cfg.evaluate(() => chrome.declarativeNetRequest.getDynamicRules().then((r) => r.length === 2)),
    'reconcile ran',
  );
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(page.url(), `${base}/ok`, 'escaped tab survived the sweep');

  // The grant is tab-scoped: a second tab on the same host is still sandboxed.
  const other = await context.newPage();
  await gotoSandboxed(other, `${base}/ok`);
  await other.close();
  await page.close();
});
