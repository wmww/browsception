// Spike 0.3 graduated into tier 1: the interception matrix (open-questions
// #8). Covers whitelist-mode rule shape (catch-all + allow priority), the
// tab-scoped escape hatch, SW-asleep interception, back/forward, and
// download/attachment + odd-scheme edges. Results table in
// notes/open-questions.md answer #8.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, extensionIdFromManifest, oracleClear, oracleRequests, HTTP_PORT } from '../harness/launch.mjs';
import { ensureFixtureServer } from '../harness/fixture-server.mjs';

const PROBE_EXT = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/probe-ext');

let server, browser, context, extId, probePage;
const viewerPrefix = () => `chrome-extension://${extId}/viewer.html?url=`;

before(async () => {
  server = await ensureFixtureServer();
  browser = await launch({ extensionDir: PROBE_EXT });
  context = browser.context;
  extId = extensionIdFromManifest(PROBE_EXT);
  probePage = await context.newPage();
  await probePage.goto(`chrome-extension://${extId}/viewer.html`);
}, { timeout: 30000 });

after(async () => {
  await browser?.close();
  await server?.stop();
});

test('blacklist interception works with the service worker stopped', async () => {
  // Kill the extension SW via CDP, then navigate — static rules must fire.
  const cdp = await context.newCDPSession(probePage);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
  if (sw) await cdp.send('Target.closeTarget', { targetId: sw.targetId });
  const page = await context.newPage();
  await page.goto('https://site-a.bstest/sw-asleep');
  assert.ok(page.url().startsWith(viewerPrefix()), `intercepted with SW stopped: ${page.url()}`);
  await page.close();
});

test('http (not just https) is intercepted', async () => {
  const page = await context.newPage();
  await page.goto('http://plain-http.bstest/x').catch(() => {});
  // plain-http.bstest is not in the blacklist; use a blacklisted domain on http.
  await page.goto(`http://site-b.bstest:${HTTP_PORT}/x`);
  assert.ok(page.url().startsWith(viewerPrefix()));
  assert.ok(page.url().includes(`http://site-b.bstest:${HTTP_PORT}/x`));
  await page.close();
});

test('attachment/download navigations on intercepted domains still redirect (request-time)', async () => {
  await oracleClear();
  const page = await context.newPage();
  await page.goto('https://site-a.bstest/download');
  assert.ok(page.url().startsWith(viewerPrefix()), 'redirect fired before response mattered');
  assert.deepEqual((await oracleRequests()).filter((r) => r.host.startsWith('site-a')), []);
  await page.close();
});

test('back/forward: history entries hold the viewer URL', async () => {
  const page = await context.newPage();
  await page.goto('https://site-a.bstest/first');
  const viewerUrl = page.url();
  assert.ok(viewerUrl.startsWith(viewerPrefix()));
  await page.goto('https://grid.bstest/');
  await page.goBack();
  assert.equal(page.url(), viewerUrl, 'back returns to the viewer entry');
  await page.goForward();
  assert.equal(page.url(), 'https://grid.bstest/');
  await page.close();
});

test('whitelist mode: catch-all intercepts everything, allow rules beat it, escape hatch is tab-scoped', async (t) => {
  // Switch the probe to whitelist mode: enable the static catch-all ruleset
  // and add an allow rule for grid.bstest (the "trusted" domain).
  await probePage.evaluate(async () => {
    await __probe.dnr.updateEnabledRulesets({ enableRulesetIds: ['catchall'] });
    await __probe.dnr.updateDynamicRules({
      removeRuleIds: [1000],
      addRules: [
        {
          id: 1000,
          priority: 10,
          action: { type: 'allow' },
          condition: {
            regexFilter: '^https?://(?:[^/:@?#]+\\.)?grid\\.bstest(?::\\d+)?(?:[/?#].*)?$',
            resourceTypes: ['main_frame'],
          },
        },
      ],
    });
  });
  t.after(async () => {
    await probePage.evaluate(async () => {
      await __probe.dnr.updateEnabledRulesets({ disableRulesetIds: ['catchall'] });
      await __probe.dnr.updateDynamicRules({ removeRuleIds: [1000] });
      await __probe.dnr.updateSessionRules({ removeRuleIds: [3000] });
    });
  });

  const page = await context.newPage();
  // Catch-all: a domain in no list is intercepted.
  await page.goto('https://input.bstest/');
  assert.ok(page.url().startsWith(viewerPrefix()), 'catch-all intercepts unlisted domain');
  // Allow beats redirect at higher priority.
  await page.goto('https://grid.bstest/');
  assert.equal(page.url(), 'https://grid.bstest/', 'whitelisted domain loads natively');

  // Escape hatch: session allow rule scoped to THIS tab for input.bstest.
  const cdp = await context.newCDPSession(page);
  const { targetInfo } = await cdp.send('Target.getTargetInfo');
  // Find the real tabId via the probe page's chrome.tabs (query by URL marker).
  await page.goto('https://app.bstest/escape-marker');
  const tabId = await probePage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => (t.url ?? t.pendingUrl ?? '').includes('escape-marker'))?.id ?? null;
  });
  assert.ok(tabId !== null, 'found tab id');
  await probePage.evaluate(
    (tabId) =>
      __probe.dnr.updateSessionRules({
        removeRuleIds: [3000],
        addRules: [
          {
            id: 3000,
            priority: 100,
            action: { type: 'allow' },
            condition: {
              regexFilter: '^https?://(?:[^/:@?#]+\\.)?input\\.bstest(?::\\d+)?(?:[/?#].*)?$',
              resourceTypes: ['main_frame'],
              tabIds: [tabId],
            },
          },
        ],
      }),
    tabId,
  );
  await page.goto('https://input.bstest/');
  assert.equal(page.url(), 'https://input.bstest/', 'escape hatch: native in this tab');
  const other = await context.newPage();
  await other.goto('https://input.bstest/');
  assert.ok(other.url().startsWith(viewerPrefix()), 'other tabs still intercepted');
  await other.close();
  await page.close();
});

test('view-source of an intercepted domain: underlying request is intercepted too', async () => {
  // Chromium issues the inner https request for view-source:, DNR redirects
  // it, and the tab commits the viewer URL (rendered as its source). No
  // target bytes fetched — the invariant holds; behavior is harmless.
  await oracleClear();
  const page = await context.newPage();
  await page.goto('view-source:https://site-a.bstest/', { waitUntil: 'commit' }).catch(() => {});
  assert.ok(page.url().startsWith(viewerPrefix()), 'view-source navigation redirected');
  assert.deepEqual((await oracleRequests()).filter((r) => r.host.startsWith('site-a')), []);
  await page.close();
});
