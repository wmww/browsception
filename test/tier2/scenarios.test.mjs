// Tier 2 — full integration: headless Chromium + the real extension + the
// real wasm engine + fixture server (notes/testing.md scenarios; graduated
// from tools/smoke-fixtures.mjs at 2.1). Needs staged engine artifacts
// (tools/stage-engine.mjs); run via `npm run test:tier2` (per-merge/nightly,
// not per-commit).
//
// Scenarios here: 7 render, 8 execute, 9 input, 14 resize, 12
// crash/recovery, 13 startup budget. 10 (navigation chrome) and 11
// (invariants) land with 2.3/2.5.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launch, extensionIdFromManifest, waitForFixtureServer } from '../harness/launch.mjs';

const EXT_DIR = new URL('../../src', import.meta.url).pathname;
const EXT_ID = extensionIdFromManifest(EXT_DIR);
const viewerURL = (target, extra = '') =>
  `chrome-extension://${EXT_ID}/ext/viewer.html?url=${encodeURIComponent(target)}${extra}`;

const fixtures = spawn('node', [new URL('../fixtures/server.mjs', import.meta.url).pathname], {
  stdio: 'ignore',
});
await waitForFixtureServer();
const session = await launch({ extensionDir: EXT_DIR });
test.after(async () => {
  await session.close();
  fixtures.kill();
});

const BOOT_TIMEOUT = 120000;

// Suite posture: dev-style blacklist covering every fixture domain, so a
// sandboxed viewer's domain always HAS sandbox disposition — required since
// 2.4's boundary policy natives nested navigations to unlisted domains.
const FIXTURE_BLACKLIST = ['grid.bstest', 'input.bstest', 'app.bstest', 'other.bstest', 'hostile.bstest'];

async function configure(patch, ready) {
  const cfg = await session.context.newPage();
  await cfg.goto(`chrome-extension://${EXT_ID}/ext/viewer.html?stub=1`);
  await cfg.evaluate((p) => chrome.storage.sync.set(p), patch);
  if (ready) {
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      if (await cfg.evaluate(ready)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await cfg.close();
}

// 2.6 shipping default, probed BEFORE any storage write: whitelist mode with
// an empty whitelist and the static catch-all enabled from the manifest, so a
// fresh install intercepts even if the SW hasn't run yet. The navigation
// lands here; the "default posture" scenario asserts on the recorded URL.
let freshInstallUrl;
test.before(async () => {
  const page = await session.context.newPage();
  await page.goto('https://other.bstest/', { waitUntil: 'commit' });
  freshInstallUrl = page.url();
  await page.close();
  await configure({ active: true, mode: 'blacklist', blacklist: FIXTURE_BLACKLIST, whitelist: [] }, () =>
    chrome.declarativeNetRequest.getDynamicRules().then((r) => r.length >= 4),
  );
});

// --- 2.6 milestone: whitelist-by-default is the fresh-install posture ------
test('default posture: fresh install sandboxes any http(s) URL with no stored state', () => {
  assert.ok(
    freshInstallUrl.startsWith(`chrome-extension://${EXT_ID}/ext/viewer.html?url=`),
    `fresh-install navigation redirected to viewer: ${freshInstallUrl}`,
  );
  assert.ok(freshInstallUrl.endsWith('url=https://other.bstest/'), `raw url plumbed: ${freshInstallUrl}`);
});

async function bootViewer(target, extra = '') {
  const page = await session.context.newPage();
  page.consoleLines = [];
  page.on('console', (m) => page.consoleLines.push(m.text()));
  await page.goto(viewerURL(target, extra));
  await page.waitForFunction(() => globalThis.__bs?.ready, undefined, { timeout: BOOT_TIMEOUT });
  return page;
}

const probe = (page, x, y) => page.evaluate(([px, py]) => __bs.probe(px, py), [x, y]);
async function until(page, x, y, pred, timeoutMs = 90000, what = 'probe') {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await probe(page, x, y);
    if (last && pred(last)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${what} @${x},${y} stuck at [${last}]`);
}
const is = (rgb) => (p) => p[0] === rgb[0] && p[1] === rgb[1] && p[2] === rgb[2];

// Guest-JS question via the console forwarder (dev-build bib_eval).
async function evalProbe(page, js, expect, tries = 40) {
  let last = '(no response)';
  for (let t = 0; t < tries; t++) {
    const marker = `T2_${t}_${Math.random().toString(36).slice(2, 8)}`;
    await page.evaluate(
      ([m, code]) => __bs.eval(`console.log(${JSON.stringify(m)} + ':' + (${code}))`),
      [marker, js],
    );
    await new Promise((r) => setTimeout(r, 500));
    const hit = page.consoleLines.find((l) => l.includes(`${marker}:`));
    if (!hit) continue;
    last = hit.slice(hit.indexOf(`${marker}:`) + marker.length + 1);
    if (expect.test(last)) return last;
  }
  throw new Error(`guest probe ${js} -> ${last.slice(0, 200)}`);
}

// --- Scenario 7: render ----------------------------------------------------
test('render: grid.bstest squares at expected coordinates', { timeout: 300000 }, async () => {
  const page = await bootViewer('https://grid.bstest/');
  await until(page, 100, 100, is([255, 0, 0]), 120000, 'grid paint');
  for (const [x, y, rgb] of [
    [300, 100, [0, 255, 0]],
    [100, 300, [0, 0, 255]],
    [300, 300, [255, 255, 0]],
    [500, 100, [0, 0, 0]],
    [700, 300, [255, 255, 255]],
  ]) {
    const p = await probe(page, x, y);
    assert.ok(is(rgb)(p), `@${x},${y} = [${p}], want [${rgb}]`);
  }
  await page.close();
});

// --- Scenario 8: execute ---------------------------------------------------
test('execute: app.bstest JS/timer/fetch/xfetch/cookie/pushState + redirect chain', { timeout: 300000 }, async () => {
  const page = await bootViewer('https://app.bstest/');
  const SW = { JS: 25, TIMER: 75, FETCH: 125, XFETCH: 175, COOKIE: 225, PUSHSTATE: 275 };
  for (const [name, x] of Object.entries(SW))
    await until(page, x, 425, is([0, 255, 0]), 120000, name);
  // Guest pushState is a same-document NEW entry — the tab history mirror
  // follows it too, not just cross-document commits.
  await pollUntil(
    () => page.url().endsWith('url=https://app.bstest/pushed'),
    'tab URL follows guest pushState',
  );
  await page.evaluate(() => __bs.eval("document.getElementById('redirlink').click()"));
  await evalProbe(page, 'location.href', /^https:\/\/app\.bstest\/final\b/);
  await page.close();
});

// --- Scenario 9: input -----------------------------------------------------
test('input: input.bstest full battery through the viewer canvas', { timeout: 300000 }, async () => {
  const page = await bootViewer('https://input.bstest/');
  const box = await (await page.$('#screen')).boundingBox();
  const at = (x, y) => [box.x + x, box.y + y];

  await until(page, 500, 100, is([0, 0, 255]), 120000, 'fixture load');
  await page.mouse.click(...at(100, 100));
  await until(page, 100, 100, is([0, 255, 0]), 60000, 'click');
  await page.mouse.dblclick(...at(100, 100));
  await until(page, 100, 100, is([255, 136, 0]), 60000, 'dblclick');
  await page.keyboard.press('a'); // body-focused: pure keydown probe
  await until(page, 300, 100, is([65, 190, 64]), 60000, 'keydown');
  await page.mouse.move(...at(600, 450));
  await page.mouse.wheel(0, 800);
  await until(page, 500, 100, (p) => p[0] > 0 && p[2] < 255, 60000, 'wheel');
  await page.mouse.click(...at(95, 240));
  await page.keyboard.type('hi', { delay: 150 });
  await until(page, 100, 350, is([209, 209, 209]), 60000, 'type checksum');
  await page.mouse.click(...at(320, 350)); // #nav link
  await until(page, 400, 300, is([102, 51, 153]), 120000, 'link navigation');
  await page.close();
});

// --- Scenario 14: resize ---------------------------------------------------
test('resize: canvas fills the window; framebuffer follows resizes; input stays aligned', { timeout: 300000 }, async () => {
  const page = await bootViewer('https://grid.bstest/');
  await until(page, 100, 100, is([255, 0, 0]), 120000, 'initial paint');

  // The canvas must fill the window below the chrome, and the ENGINE
  // framebuffer (readback geometry, not canvas CSS) must match its layout
  // size — probes assert on __bs.fb, which only bibFrame updates.
  const fbMatchesCanvas = (what) =>
    pollUntil(
      () =>
        page.evaluate(() => {
          const r = document.getElementById('screen').getBoundingClientRect();
          const w = Math.round(r.width * devicePixelRatio);
          const h = Math.round(r.height * devicePixelRatio);
          const fills = Math.abs(r.right - innerWidth) < 2 && Math.abs(r.bottom - innerHeight) < 2;
          return fills && __bs.fb && Math.abs(__bs.fb.w - w) <= 1 && Math.abs(__bs.fb.h - h) <= 1
            ? { w: __bs.fb.w, h: __bs.fb.h }
            : null;
        }),
      what,
    );

  // Boot: left the 800x600 engine default for the real layout size
  // (harness viewport is 1280x720).
  const initial = await fbMatchesCanvas('boot framebuffer matches canvas');
  assert.ok(initial.w > 800 && initial.h > 600, `left boot default: ${JSON.stringify(initial)}`);

  // Grow: framebuffer follows, and the engine painted the new area (probe
  // near the new corner — grid.bstest background is white).
  await page.setViewportSize({ width: 1500, height: 900 });
  const grown = await fbMatchesCanvas('grown framebuffer matches canvas');
  assert.ok(grown.w > initial.w && grown.h > initial.h, `grew: ${JSON.stringify(grown)}`);
  await until(page, grown.w - 10, grown.h - 10, is([255, 255, 255]), 60000, 'grown area painted');
  await until(page, 100, 100, is([255, 0, 0]), 60000, 'content intact after grow');

  // Shrink: framebuffer shrinks too; old coordinates fall out of bounds.
  await page.setViewportSize({ width: 700, height: 500 });
  const shrunk = await fbMatchesCanvas('shrunk framebuffer matches canvas');
  assert.ok(shrunk.w <= 700 && shrunk.w < grown.w && shrunk.h < grown.h, `shrank: ${JSON.stringify(shrunk)}`);
  assert.equal(await probe(page, 1400, 100), null, 'old width out of bounds after shrink');

  // Input alignment at the post-resize size: canvas CSS px must still map
  // 1:1 onto framebuffer px (click zone turns green).
  await page.evaluate(() => __bs.navigate('https://input.bstest/'));
  await until(page, 500, 100, is([0, 0, 255]), 120000, 'input fixture load');
  const box = await (await page.$('#screen')).boundingBox();
  await page.mouse.click(box.x + 100, box.y + 100);
  await until(page, 100, 100, is([0, 255, 0]), 60000, 'click lands after resize');
  await page.close();
});

// --- Scenario 12: crash / recovery ----------------------------------------
test('crash: engine abort -> crashed UI -> reload recovers', { timeout: 300000 }, async () => {
  const page = await bootViewer('https://grid.bstest/');
  await until(page, 100, 100, is([255, 0, 0]), 120000, 'pre-crash paint');
  await page.evaluate(() => Module._bib_crash());
  await page.waitForFunction(() => __bs.dead === true, undefined, { timeout: 30000 });
  const boot = await page.evaluate(() => document.getElementById('boot').textContent);
  assert.match(boot, /crashed/i);
  await page.reload();
  await page.waitForFunction(() => globalThis.__bs?.ready, undefined, { timeout: BOOT_TIMEOUT });
  await until(page, 100, 100, is([255, 0, 0]), 120000, 'post-reload paint');
  await page.close();
});

// --- 2.2 milestone: live blacklist interception end to end -----------------
test('interception: blacklisted navigation lands in the viewer and renders sandboxed', { timeout: 300000 }, async () => {
  // Navigate a plain tab to a blacklisted domain — like typing in the
  // omnibox. DNR must redirect it to the viewer, which renders it nested.
  const page = await session.context.newPage();
  await page.goto('https://grid.bstest/');
  assert.ok(
    page.url().startsWith(`chrome-extension://${EXT_ID}/ext/viewer.html?url=`),
    `redirected to viewer: ${page.url()}`,
  );
  assert.ok(page.url().endsWith('url=https://grid.bstest/'), `raw url plumbed: ${page.url()}`);
  await page.waitForFunction(() => globalThis.__bs?.ready, undefined, { timeout: BOOT_TIMEOUT });
  await until(page, 100, 100, is([255, 0, 0]), 120000, 'nested render after interception');
  await page.close();
});

// --- 2.2/2.4: symmetric sweep — list edits convert open tabs both ways -----
test('sweep: list edits convert open tabs (native->viewer and viewer->native)', { timeout: 300000 }, async () => {
  // Unlist app.bstest; an open viewer tab on it must LEAVE the sandbox.
  const nested = await session.context.newPage();
  await nested.goto('https://app.bstest/');
  assert.ok(nested.url().startsWith(`chrome-extension://${EXT_ID}/`), 'sandboxed while listed');
  await configure({ blacklist: FIXTURE_BLACKLIST.filter((d) => d !== 'app.bstest') });
  // startsWith: the fixture pushState()s to /pushed as soon as it runs.
  await pollUntil(() => nested.url().startsWith('https://app.bstest/'), 'viewer tab swept to native');

  // Re-list it; the (now-native) tab must sweep back into a viewer.
  await configure({ blacklist: FIXTURE_BLACKLIST });
  await pollUntil(
    () => nested.url().startsWith(`chrome-extension://${EXT_ID}/ext/viewer.html?url=https://app.bstest/`),
    'native tab swept to viewer',
  );
  await nested.close();
});

// --- Scenario 10: navigation chrome (2.3) ----------------------------------
async function pollUntil(fn, what, timeoutMs = 30000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} (last: ${JSON.stringify(last)})`);
}

// --- Scenario 10: navigation chrome ---------------------------------------
// The viewer has no back/forward/reload buttons: the TAB's history mirrors
// the engine's, so the browser's own controls drive it. Asserting tab.url
// tracks nested navigation is also the regression test for the popup escape
// hatch, which slices the live target out of it.
const rawViewerURL = (target) => `chrome-extension://${EXT_ID}/ext/viewer.html?url=${target}`;

test('chrome: tab URL + native back/forward/reload drive the engine', { timeout: 300000 }, async () => {
  const page = await bootViewer('https://input.bstest/');
  const box = await (await page.$('#screen')).boundingBox();
  const at = (x, y) => [box.x + x, box.y + y];
  const urlbar = () => page.evaluate(() => document.getElementById('urlbar').value);
  // Native history, driven the way the toolbar buttons do; same-document
  // traversals produce no response, so don't let the wait dominate.
  const back = () => page.goBack({ timeout: 20000 }).catch(() => {});
  const forward = () => page.goForward({ timeout: 20000 }).catch(() => {});

  await until(page, 500, 100, is([0, 0, 255]), 120000, 'fixture load');
  await pollUntil(async () => (await urlbar()) === 'https://input.bstest/', 'urlbar shows fixture URL');
  // Entry-point tab URL (percent-encoded here) is REPLACED by the live one,
  // raw — popup/sweep slice at url= without decoding.
  await pollUntil(
    () => page.url() === rawViewerURL('https://input.bstest/'),
    'tab URL synced to the committed URL',
  );
  assert.ok(await page.evaluate(() => !document.getElementById('back')), 'no in-viewer back button');

  // Nested link click -> new tab entry, URL bar + tab URL follow.
  await page.mouse.click(...at(320, 350));
  await until(page, 400, 300, is([102, 51, 153]), 120000, 'link nav');
  await pollUntil(async () => (await urlbar()) === 'https://input.bstest/final.html', 'urlbar follows link');
  await pollUntil(
    () => page.url() === rawViewerURL('https://input.bstest/final.html'),
    'tab URL follows nested navigation',
  );
  await pollUntil(() => page.evaluate(() => __bs.state.canGoBack), 'engine can go back');
  await pollUntil(async () => (await page.title()) === 'NAV-TARGET', 'nested title -> tab title');

  // Native back: popstate -> bib_go, same document, no engine reboot.
  const bootMs = await page.evaluate(() => __bs.metrics.bootMs);
  await back();
  await until(page, 500, 100, is([0, 0, 255]), 120000, 'back re-renders fixture');
  await pollUntil(async () => (await urlbar()) === 'https://input.bstest/', 'urlbar after back');
  await pollUntil(
    () => page.url() === rawViewerURL('https://input.bstest/'),
    'tab URL after back',
  );
  assert.equal(
    await page.evaluate(() => __bs.metrics.bootMs),
    bootMs,
    'traversal reused the live engine (no reboot)',
  );
  await pollUntil(() => page.evaluate(() => __bs.state.canGoForward), 'engine can go forward');

  await forward();
  await until(page, 400, 300, is([102, 51, 153]), 120000, 'forward re-renders target');
  await pollUntil(
    () => page.url() === rawViewerURL('https://input.bstest/final.html'),
    'tab URL after forward',
  );

  // Native reload: re-navigates the mirrored entry, so the engine reboots on
  // the page actually being viewed (not the entry point).
  await page.reload();
  await page.waitForFunction(() => globalThis.__bs?.ready, undefined, { timeout: BOOT_TIMEOUT });
  await until(page, 400, 300, is([102, 51, 153]), 120000, 'reload renders target');
  await pollUntil(async () => (await urlbar()) === 'https://input.bstest/final.html', 'urlbar after reload');

  // Traversing to an entry the rebooted engine never had: falls back to
  // loading the entry's URL.
  await back();
  await until(page, 500, 100, is([0, 0, 255]), 120000, 'back after reload cold-loads the entry');
  await pollUntil(async () => (await urlbar()) === 'https://input.bstest/', 'urlbar after post-reload back');
  await page.close();
});

// --- escape hatch: open natively, this tab only ----------------------------
// Driven the way the popup drives it (message + explicit tabId); the popup
// itself isn't a tab, so it can't be scripted here.
test('escape hatch: popup reopens the tab natively; other tabs stay sandboxed', { timeout: 300000 }, async () => {
  const page = await session.context.newPage();
  await page.goto('https://grid.bstest/');
  assert.ok(page.url().startsWith(`chrome-extension://${EXT_ID}/`), 'sandboxed first');
  await page.waitForFunction(() => globalThis.__bs?.ready, undefined, { timeout: BOOT_TIMEOUT });
  await pollUntil(
    () => page.evaluate(() => __bs.state.url === 'https://grid.bstest/'),
    'engine committed the target',
  );

  const chromeUI = await session.context.newPage();
  await chromeUI.goto(`chrome-extension://${EXT_ID}/ext/viewer.html?stub=1`);
  const ok = await chromeUI.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((t) => (t.url ?? '').includes('viewer.html?url=https%3A%2F%2Fgrid.bstest%2F')
      || (t.url ?? '').includes('viewer.html?url=https://grid.bstest/'));
    if (!target) return false;
    const r = await chrome.runtime.sendMessage({
      type: 'open-natively', url: 'https://grid.bstest/', tabId: target.id,
    });
    return !!r?.ok;
  });
  assert.ok(ok, 'popup-style escape request accepted');
  await chromeUI.close();
  await pollUntil(() => page.url() === 'https://grid.bstest/', 'tab went native', 30000);

  const other = await session.context.newPage();
  await other.goto('https://grid.bstest/');
  assert.ok(other.url().startsWith(`chrome-extension://${EXT_ID}/`), 'other tabs still sandboxed');
  await other.close();
  await page.close(); // tab close reaps the session escape rule
});

// --- 2.4 boundary: sandboxed page navigating to a native-disposition URL ---
test('boundary: nested navigation to a whitelisted domain hands the real tab the URL', { timeout: 300000 }, async () => {
  // Whitelist mode, grid.bstest trusted: everything else sandboxed via the
  // static catch-all; a nested navigation to grid.bstest must go NATIVE.
  await configure({ mode: 'whitelist', whitelist: ['grid.bstest'] }, () =>
    chrome.declarativeNetRequest.getEnabledRulesets().then((r) => r.includes('catchall')),
  );

  const page = await session.context.newPage();
  await page.goto('https://input.bstest/');
  assert.ok(page.url().startsWith(`chrome-extension://${EXT_ID}/`), 'unlisted domain sandboxed');
  await page.waitForFunction(() => globalThis.__bs?.ready, undefined, { timeout: BOOT_TIMEOUT });
  await until(page, 500, 100, is([0, 0, 255]), 120000, 'fixture render');

  await page.evaluate(() => __bs.eval("location.href = 'https://grid.bstest/'"));
  await pollUntil(() => page.url() === 'https://grid.bstest/', 'real tab went native', 60000);
  await page.close();

  // Restore the suite's blacklist posture.
  await configure({ mode: 'blacklist', whitelist: [] }, () =>
    chrome.declarativeNetRequest.getEnabledRulesets().then((r) => !r.includes('catchall')),
  );
});

// --- Scenario 11: guard-rail invariants (2.5) ------------------------------
import { oracleClear, oracleRequests } from '../harness/launch.mjs';

test('invariants: hostile.bstest — guard blocks private-network; no target document loads top-level', { timeout: 300000 }, async () => {
  await oracleClear();
  const cdpTargets = []; // any top-level target navigated to a fixture origin
  const page = await bootViewer('https://hostile.bstest/');
  const cdp = await session.context.newCDPSession(page);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  cdp.on('Target.targetInfoChanged', ({ targetInfo }) => {
    // ORIGIN, not substring: the viewer's own URL embeds ?url=…bstest, and
    // the tab-history mirror rewrites it on every nested navigation.
    if (targetInfo.type === 'page' && /^https?:\/\/[^/]*\.bstest/.test(targetInfo.url))
      cdpTargets.push(targetInfo.url);
  });

  // Drive the guest pass to completion, then read its per-attempt verdicts.
  const results = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const text = await evalProbe(
        page,
        "document.getElementById('results').innerText.replace(/\\n/g,'|')",
        /./,
        1,
      ).catch(() => '');
      if (/DONE-SENTINEL/.test(text)) return text;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('hostile pass never completed');
  })();

  // Every private-network / bad-scheme / bad-port attempt must be blocked.
  for (const name of ['loopback-port1', 'localhost', 'rfc1918', 'metadata', 'v6-loopback', 'bad-port-25', 'ftp', 'file'])
    assert.match(results, new RegExp(`${name}: blocked`), `${name} must be blocked (got: ${results})`);

  // Oracle: no private/blocked request ever reached a fixture wire, and the
  // host jar never rode a bridge request (credentials:'omit', structurally).
  const reqs = await oracleRequests();
  assert.equal(reqs.filter((r) => r.headers.cookie).length, 0, 'no host-jar cookie on any bridge request');

  // The nested document must never exist as a real frame: the engine renders
  // to canvas pixels, so every frame in the tab is extension-origin (the
  // viewer's own URL embeds ?url=…bstest in its query — check the frame
  // ORIGIN, not a substring of the URL).
  assert.equal(page.url().startsWith(`chrome-extension://${EXT_ID}/`), true, 'tab stays on the extension origin');
  // No frame may carry a fixture (http/https) origin — that would mean target
  // bytes were parsed into a real document. Extension-origin and opaque
  // (about:blank / null) frames are fine.
  const httpFrameUrls = page.frames().map((f) => f.url()).filter((u) => /^https?:/.test(u));
  assert.deepEqual(httpFrameUrls, [], `no http(s)-origin frame in the tab (got ${JSON.stringify(httpFrameUrls)})`);
  assert.deepEqual(cdpTargets, [], 'no top-level target navigated to a fixture origin');
  await page.close();
});

// --- Scenario 13: startup budget (regression tripwire, generous) -----------
test('startup: warm boot to interactive under 15 s', { timeout: 300000 }, async () => {
  // Second+ boot in this profile = warm (compiled-wasm cache, if any).
  const page = await bootViewer('https://grid.bstest/');
  const ms = await page.evaluate(() => __bs.metrics.bootMs);
  console.log(`      warm bootMs: ${ms}`);
  assert.ok(ms < 15000, `warm boot ${ms} ms exceeds 15 s tripwire`);
  await page.close();
});
