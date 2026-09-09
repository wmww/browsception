#!/usr/bin/env node
// Firefox phase-0 probes (plans/one-engine-both-browsers.md § Phases & gates,
// item 0) against the system Firefox, headless, via test/harness/firefox.mjs.
// Needs the fixture server running: node test/fixtures/server.mjs
//
//   node tools/probe-firefox.mjs [--only 1,3] [--verbose]
//
// Prints one row per probe (PASS/FAIL + observation) and, with --verbose,
// the raw detail JSON. Nothing here is a regression test; it is a lab bench.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchFirefox, oracleClear, oracleRequests } from '../test/harness/firefox.mjs';
import { waitForOwnFixtureServer } from '../test/harness/ports.mjs';
import { catchallRules, escapeSessionRule, entryRegex, PRIORITY } from '../src/ext/dnr-rules.mjs';
import { baseSessionRules, perRequestHeaderRule } from '../src/ext/bridge-rules.mjs';
import { GECKO_ID, UUID, VIEWER } from '../test/fixtures/probe-ext-firefox/gen.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = join(ROOT, 'test/fixtures/probe-ext-firefox');
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',').map(Number) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v) => JSON.stringify(v)?.slice(0, 400);

// ------------------------------------------------------------------ probes
const probes = [];
const probe = (n, name, run) => probes.push({ n, name, run });

// 1. DNR main_frame redirect (static catch-all, dynamic, allow, session tabIds).
probe(1, 'DNR main_frame redirect', async ({ ff, viewer }) => {
  const d = {};
  d.enabledRulesets = await viewer.evaluate(() => __probe.dnr.getEnabledRulesets());
  d.availableStatic = await viewer.evaluate(() => __probe.dnr.getAvailableStaticRuleCount());
  d.extUrl = await viewer.evaluate(() => __probe.extUrl());
  d.extId = await viewer.evaluate(() => __probe.extId());

  // Static catch-all: plain tab → https://grid.bstest/ must land on viewer.
  const tab = await ff.newPage();
  await oracleClear();
  d.staticNav = await tab.goto('https://grid.bstest/').catch((e) => ({ error: e.message }));
  d.staticUrl = await tab.url();
  d.staticLanded = await tab.evaluate(() => ({ href: location.href, search: location.search, title: document.title })).catch((e) => e.message);
  d.staticOracle = (await oracleRequests()).map((r) => `${r.host}${r.path}`);
  const staticOk = d.staticUrl === `${VIEWER}?url=https://grid.bstest/`;

  // Query-string + fragment survive raw?
  d.qsNav = await tab.goto('https://grid.bstest/a?b=1&c=2#frag').catch((e) => ({ error: e.message }));
  d.qsUrl = await tab.url();

  // Disable static ruleset → navigation goes native.
  d.disable = await viewer.evaluate(() => __probe.dnr.updateEnabledRulesets({ disableRulesetIds: ['catchall'] }));
  d.enabledAfterDisable = await viewer.evaluate(() => __probe.dnr.getEnabledRulesets());
  await oracleClear();
  await tab.goto('https://grid.bstest/').catch(() => {});
  d.nativeUrl = await tab.url();
  d.nativeOracle = (await oracleRequests()).map((r) => `${r.host}${r.path}`);

  // Dynamic rules: the same catch-all shape + a whitelist allow rule.
  const dyn = catchallRules(VIEWER).map((r) => ({ ...r, id: 500 }));
  d.dynAdd = await viewer.evaluate((rules) => __probe.dnr.updateDynamicRules({ addRules: rules }), dyn);
  d.dynRules = await viewer.evaluate(() => __probe.dnr.getDynamicRules());
  await tab.goto('https://input.bstest/').catch(() => {});
  d.dynUrl = await tab.url();
  const allow = {
    id: 1000,
    priority: PRIORITY.ALLOW,
    action: { type: 'allow' },
    condition: { regexFilter: entryRegex('input.bstest'), resourceTypes: ['main_frame'] },
  };
  d.allowAdd = await viewer.evaluate((r) => __probe.dnr.updateDynamicRules({ addRules: [r] }), allow);
  await tab.goto('https://input.bstest/').catch(() => {});
  d.allowUrl = await tab.url();
  await tab.goto('https://app.bstest/').catch(() => {});
  d.allowOtherUrl = await tab.url();

  // Relative regexSubstitution (would remove the need to know the UUID).
  d.relAdd = await viewer.evaluate(() =>
    __probe.dnr.updateDynamicRules({
      addRules: [{ id: 501, priority: 5, action: { type: 'redirect', redirect: { regexSubstitution: '/viewer.html?rel=1&url=\\0' } }, condition: { regexFilter: '^https://final\\.bstest/.*', resourceTypes: ['main_frame'] } }],
    }),
  );
  if (d.relAdd == null) {
    await oracleClear();
    await tab.goto('https://final.bstest/x').catch(() => {});
    d.relUrl = await tab.url();
    d.relOracle = (await oracleRequests()).map((r) => `${r.host}${r.path}`);
    await viewer.evaluate(() => __probe.dnr.updateDynamicRules({ removeRuleIds: [501] }));
  }
  // extensionPath (no \0): what does Firefox do?
  d.extPathAdd = await viewer.evaluate(() =>
    __probe.dnr.updateDynamicRules({
      addRules: [{ id: 502, priority: 5, action: { type: 'redirect', redirect: { extensionPath: '/viewer.html?ep=1' } }, condition: { regexFilter: '^https://final\\.bstest/.*', resourceTypes: ['main_frame'] } }],
    }),
  );
  if (d.extPathAdd == null) {
    await tab.goto('https://final.bstest/y?z=1').catch(() => {});
    d.extPathUrl = await tab.url();
    await viewer.evaluate(() => __probe.dnr.updateDynamicRules({ removeRuleIds: [502] }));
  }

  // Session rule with tabIds (escape hatch): allow app.bstest in THIS tab only.
  await tab.goto('https://app.bstest/').catch(() => {});
  const tabs = await viewer.evaluate(() => __probe.tabs.query({}));
  d.tabs = tabs.map((t) => ({ id: t.id, url: t.url }));
  const tabId = tabs.find((t) => t.url?.includes('app.bstest'))?.id;
  d.tabId = tabId;
  if (tabId == null) throw new Error(`no app.bstest tab among ${short(d.tabs)}`);
  const esc = escapeSessionRule(tabId, 'app.bstest');
  d.sessionAdd = await viewer.evaluate((r) => __probe.dnr.updateSessionRules({ addRules: [r] }), esc);
  d.sessionRules = await viewer.evaluate(() => __probe.dnr.getSessionRules());
  await tab.goto('https://app.bstest/').catch(() => {});
  d.escapeUrl = await tab.url();
  const other = await ff.newPage();
  await other.goto('https://app.bstest/').catch(() => {});
  d.escapeOtherTabUrl = await other.url();
  await other.close();

  // Cleanup: dynamic + session rules off, static back on.
  await viewer.evaluate(() => __probe.dnr.updateDynamicRules({ removeRuleIds: [500, 1000] }));
  await viewer.evaluate((id) => __probe.dnr.updateSessionRules({ removeRuleIds: [id] }), esc.id);
  d.reenable = await viewer.evaluate(() => __probe.dnr.updateEnabledRulesets({ enableRulesetIds: ['catchall'] }));
  await tab.goto('https://grid.bstest/').catch(() => {});
  d.reenabledUrl = await tab.url();
  await tab.close();

  const pass =
    staticOk &&
    d.qsUrl === `${VIEWER}?url=https://grid.bstest/a?b=1&c=2#frag` &&
    d.nativeUrl === 'https://grid.bstest/' &&
    d.dynUrl === `${VIEWER}?url=https://input.bstest/` &&
    d.allowUrl === 'https://input.bstest/' &&
    d.allowOtherUrl === `${VIEWER}?url=https://app.bstest/` &&
    d.escapeUrl.startsWith('https://app.bstest/') && // fixture pushStates to /pushed
    d.escapeOtherTabUrl === `${VIEWER}?url=https://app.bstest/` &&
    d.reenabledUrl === `${VIEWER}?url=https://grid.bstest/`;
  return {
    pass,
    note: `static→${d.staticUrl}; qs→${d.qsUrl}; disabled→${d.nativeUrl}; dyn→${d.dynUrl}; allow→${d.allowUrl}/${d.allowOtherUrl}; session tabIds→${d.escapeUrl} (other tab ${d.escapeOtherTabUrl}); relative subst: ${d.relAdd ?? `${d.relUrl} (oracle ${short(d.relOracle)})`}; extensionPath: ${d.extPathAdd ?? d.extPathUrl}`,
    detail: d,
  };
});

// 2. Session modifyHeaders on the extension page's own fetches.
probe(2, 'session modifyHeaders (cookie/UA/referer/origin)', async ({ ff, viewer }) => {
  const d = {};
  const UA = 'BS-PROBE-UA/1.0';
  const url = 'https://app.bstest/echo-headers';
  // The plain tab must actually be plain: static redirects off for this probe.
  await viewer.evaluate(() => __probe.dnr.updateEnabledRulesets({ disableRulesetIds: ['catchall', 'blacklist'] }));
  const tryScope = async (label, initiator) => {
    const rules = [
      ...baseSessionRules(initiator, { userAgent: UA }),
      perRequestHeaderRule(10001, url, { cookie: 'bs=probe', referer: 'https://ref.example/', origin: 'https://orig.example' }, initiator),
    ];
    const add = await viewer.evaluate((r) => __probe.dnr.updateSessionRules({ addRules: r }), rules);
    await oracleClear();
    const ext = await viewer.evaluate((u) => __probe.fetchProbe({ u, url: u }), url);
    const plain = await ff.newPage();
    await plain.goto('https://grid.bstest/').catch(() => {});
    const plainUrl = await plain.url();
    // plain tab's fetch through DNR? (must be untouched)
    const plainFetch = await plain.evaluate(async (u) => {
      try {
        const r = await fetch(u, { cache: 'no-store' });
        return { status: r.status, body: (await r.text()).slice(0, 300) };
      } catch (e) {
        return { error: String(e) };
      }
    }, url).catch((e) => ({ error: e.message }));
    await plain.close();
    const reqs = (await oracleRequests()).filter((r) => r.path === '/echo-headers');
    await viewer.evaluate((ids) => __probe.dnr.updateSessionRules({ removeRuleIds: ids }), rules.map((r) => r.id));
    return {
      add,
      extFetch: { status: ext.status, error: ext.error },
      plainUrl,
      plainFetch,
      wire: reqs.map((r) => ({
        ua: r.headers['user-agent'],
        cookie: r.headers.cookie ?? null,
        referer: r.headers.referer ?? null,
        origin: r.headers.origin ?? null,
        secFetchMode: r.headers['sec-fetch-mode'],
      })),
    };
  };
  d.byUuid = await tryScope('uuid', UUID);
  d.byGeckoId = await tryScope('gecko-id', GECKO_ID);
  // Also: extension-page fetch is CORS-exempt for a non-CORS route.
  d.corsExempt = await viewer.evaluate(() =>
    __probe.fetchProbe({ url: 'https://app.bstest/api/data', init: { credentials: 'omit', redirect: 'error', cache: 'no-store' } }),
  );
  d.corsExemptPlainHttp = await viewer.evaluate(() =>
    __probe.fetchProbe({ url: 'http://plain-http.bstest/api/data', init: { credentials: 'omit', redirect: 'error', cache: 'no-store' } }),
  );
  await viewer.evaluate(() => __probe.dnr.updateEnabledRulesets({ enableRulesetIds: ['catchall', 'blacklist'] }));
  const pick = (s) => s.wire.find((w) => w.ua === UA);
  const good = (s) => {
    const w = pick(s);
    const untouched = s.wire.find((w2) => w2 !== w);
    return !!w && w.cookie === 'bs=probe' && w.referer === 'https://ref.example/' && w.origin === 'https://orig.example' && untouched && untouched.cookie === null && untouched.ua?.includes('Firefox');
  };
  d.wireSummary = { uuid: d.byUuid.wire, plainUrl: d.byUuid.plainUrl, plainFetch: d.byUuid.plainFetch };
  const pass = (good(d.byUuid) || good(d.byGeckoId)) && d.corsExempt.status === 200 && d.corsExempt.type === 'basic';
  return {
    pass,
    note: `initiatorDomains=<uuid>: ${good(d.byUuid) ? `ext fetch got UA/Cookie/Referer/Origin on the wire, plain tab (${d.byUuid.plainUrl}) untouched` : `no (wire=${short(d.byUuid.wire)}, add=${d.byUuid.add})`}; =<gecko id>: ${good(d.byGeckoId) ? 'headers on wire' : `no (add=${d.byGeckoId.add})`}; CORS-exempt fetch: ${d.corsExempt.status}/${d.corsExempt.type}${d.corsExempt.error ?? ''}; plain-http: ${d.corsExemptPlainHttp.status ?? d.corsExemptPlainHttp.error}`,
    detail: d,
  };
});

// 3. webRequest capture from an extension page (+ event page listener).
probe(3, 'webRequest capture (Set-Cookie, 302 under redirect:error)', async ({ ff, viewer }) => {
  const d = {};
  d.specErrors = await viewer.evaluate(() =>
    __probe.wrStart({
      onHeadersReceived: ['responseHeaders', 'extraHeaders'],
      onBeforeRedirect: ['responseHeaders'],
      onCompleted: ['responseHeaders'],
      onErrorOccurred: [],
    }),
  );
  // If extraHeaders was rejected, register without it.
  if (d.specErrors.onHeadersReceived !== 'ok')
    d.specErrors2 = await viewer.evaluate(() => __probe.wrStart({ onHeadersReceived: ['responseHeaders'] }));
  await viewer.evaluate(() => __probe.wrClear());
  const url = 'https://app.bstest/set-cookie?n=bsff&v=1&attrs=; Path=/; HttpOnly&then=/final';
  d.fetch = await viewer.evaluate((u) => __probe.fetchProbe({ url: u, init: { redirect: 'error' } }), url);
  await sleep(500);
  d.events = await viewer.evaluate(() => __probe.wrDump());
  const hr = d.events.find((e) => e.event === 'onHeadersReceived' && e.url.includes('/set-cookie'));
  const br = d.events.find((e) => e.event === 'onBeforeRedirect' && e.url.includes('/set-cookie'));
  const setCookie = hr?.responseHeaders?.filter((h) => h.name.toLowerCase() === 'set-cookie');
  const location = hr?.responseHeaders?.find((h) => h.name.toLowerCase() === 'location');
  d.summary = {
    fetchError: d.fetch.error,
    onHeadersReceived: hr && { status: hr.statusCode, setCookie, location: location?.value, initiator: hr.initiator, originUrl: hr.originUrl, documentUrl: hr.documentUrl, tabId: hr.tabId },
    onBeforeRedirect: br && { status: br.statusCode, redirectUrl: br.redirectUrl, setCookie: br.responseHeaders?.filter((h) => h.name.toLowerCase() === 'set-cookie') },
    eventNames: d.events.map((e) => `${e.event}:${e.statusCode ?? ''}`),
  };
  // Does onBeforeRedirect fire at all (redirect:'follow')?
  await viewer.evaluate(() => __probe.wrClear());
  d.follow = await viewer.evaluate((u) => __probe.fetchProbe({ url: u, init: { redirect: 'follow' } }), url);
  await sleep(300);
  d.followEvents = (await viewer.evaluate(() => __probe.wrDump())).map((e) => `${e.event}:${e.statusCode ?? ''}${e.redirectUrl ? `→${e.redirectUrl}` : ''}`);
  // Plain 200 with Set-Cookie (no redirect).
  await viewer.evaluate(() => __probe.wrClear());
  await viewer.evaluate(() => __probe.fetchProbe({ url: 'https://app.bstest/set-cookie?n=plain&v=2' }));
  await sleep(300);
  const ev2 = await viewer.evaluate(() => __probe.wrDump());
  d.plain200 = ev2.filter((e) => e.event === 'onHeadersReceived').map((e) => ({ status: e.statusCode, setCookie: e.responseHeaders?.filter((h) => h.name.toLowerCase() === 'set-cookie') }));

  // Event page: was the top-level listener registered before the fetch; does
  // it survive suspension? (extensions.background.idle.timeout is lowered by
  // the driver's prefs.)
  d.bgAudit1 = await viewer.evaluate(() => __probe.bg('audit'));
  d.bgEventsNow = await viewer.evaluate(() => __probe.bg('bgEvents'));
  await sleep(4000); // > idle timeout → event page should be suspended
  await oracleClear();
  await viewer.evaluate(() => __probe.fetchProbe({ url: 'https://app.bstest/api/cors' }));
  await sleep(1000);
  d.bgAudit2 = await viewer.evaluate(() => __probe.bg('audit'));
  d.bgEventsAfter = await viewer.evaluate(() => __probe.storageLocal('bgEvents'));
  d.bgRestarted = d.bgAudit1?.loadedAt !== d.bgAudit2?.loadedAt;
  const bgSaw = (d.bgEventsAfter?.bgEvents ?? []).some((e) => e.url.includes('/api/cors'));

  const pass = !!hr && hr.statusCode === 302 && setCookie?.length === 1 && !!location && bgSaw;
  return {
    pass,
    note: `extraHeaders: ${d.specErrors.onHeadersReceived}; onHeadersReceived under redirect:'error': ${hr ? `status ${hr.statusCode}, Location ${location?.value}, Set-Cookie ${short(setCookie?.map((h) => h.value))}` : 'NOT FIRED'}; onBeforeRedirect: ${br ? `status ${br.statusCode} → ${br.redirectUrl}` : 'not fired'} (events: ${d.summary.eventNames.join(',')}; with redirect:'follow': ${d.followEvents.join(',')}); initiator=${short(hr?.initiator)} originUrl=${short(hr?.originUrl)}; event page: restarted after idle=${d.bgRestarted}, listener saw fetch=${bgSaw}`,
    detail: d,
  };
});

// 4. OPFS.
probe(4, 'OPFS on moz-extension page', async ({ viewer }) => {
  const d = await viewer.evaluate(() => __probe.opfs());
  return { pass: d.readBack === 'hello-opfs', note: short(d), detail: d };
});

// 5. Worker + big memory + importScripts/import().
probe(5, 'Worker: 1.5+ GB non-shared wasm memory, importScripts, import()', async ({ viewer }) => {
  const d = {};
  d.isolation = await viewer.evaluate(() => __probe.isolation());
  d.memory = await viewer.evaluate(() => __probe.worker('memory'));
  d.scripts = await viewer.evaluate(() => __probe.worker('scripts'));
  const reached = d.memory.finalMB ?? 0;
  const pass = reached >= 1536 && d.scripts.importScripts === 'importScripts-ok' && d.scripts.dynamicImport === 'dynamic-import-ok' && d.isolation.crossOriginIsolated === false;
  return {
    pass,
    note: `memory: create ${short(d.memory.create)}, grew to ${reached} MB (${short(d.memory.grow)}); maxAlone=${short(d.memory.maxAlone)}; shared: ${d.memory.sharedAttempt}; importScripts=${d.scripts.importScripts}; import()=${d.scripts.dynamicImport}; page crossOriginIsolated=${d.isolation.crossOriginIsolated} SAB=${d.isolation.sab}`,
    detail: d,
  };
});

// 6. WebGL2 presenter.
probe(6, 'WebGL2 texSubImage2D presenter (headless)', async ({ viewer }) => {
  const d = await viewer.evaluate(() => __probe.webgl2(60));
  return {
    pass: d.hasContext && d.glError === 0,
    note: d.hasContext
      ? `webgl2 ok: ${d.renderer} (${d.unmasked ?? '?'}), attrs=${short(d.attrs)}, 1600x900 RGBA texSubImage2D median ${d.uploadMsMedian} ms (max ${d.uploadMsMax}); 2d putImageData median ${d.putImageDataMsMedian} ms`
      : `no webgl2 context (webgl1: ${d.webgl1}); 2d putImageData median ${d.putImageDataMsMedian} ms`,
    detail: d,
  };
});

// 7. Event page audit.
probe(7, 'event page audit (chrome.* namespace)', async ({ viewer }) => {
  const d = await viewer.evaluate(() => __probe.bg('audit'));
  const pass = d && d.dnr === 'object' && d.storageSession === 'object' && d.tabsQuery === 'function' && d.runtimeOnMessage === 'object' && d.actionSetBadgeText === 'function' && d.promiseReturning.tabsQuery === true;
  return {
    pass,
    note: `dnr=${d?.dnr} storage.session=${d?.storageSession} tabs.query/update=${d?.tabsQuery}/${d?.tabsUpdate} runtime.onMessage=${d?.runtimeOnMessage} action.setBadgeText=${d?.actionSetBadgeText}; promise-returning: ${short(d?.promiseReturning)}; self.registration=${d?.selfRegistration} clients=${d?.clients} alarms=${d?.alarms} document=${d?.documentPresent} window=${d?.windowPresent}; errors: ${d?.storageSessionError ?? ''} ${d?.setBadgeError ?? ''}`,
    detail: d,
  };
});

// 8. CSP + wasm + Chrome-only manifest keys.
probe(8, "CSP 'wasm-unsafe-eval' + Chrome-only manifest keys", async ({ ff, viewer }) => {
  const d = {};
  d.page = await viewer.evaluate(() => __probe.wasmPage());
  d.eval = await viewer.evaluate(() => __probe.evalBlocked());
  d.atLoad = await viewer.evaluate(() => __cspAtLoad);
  d.worker = await viewer.evaluate(() => __probe.worker('wasm'));
  d.installWarnings = ff.stderr.concat(ff.stdout).filter((l) => /manifest|Warning|warning|key|declarative|ruleset|rule/i.test(l) && !/Realm\.sys/.test(l));
  // Manifest warnings are shown per temporary extension on about:debugging.
  const dbg = await ff.newPage();
  await dbg.goto('about:debugging#/runtime/this-firefox').catch(() => {});
  d.aboutDebugging = await dbg
    .waitForFunction(`document.body.innerText.includes('browsception firefox probe') ? document.body.innerText : null`, { timeout: 8000 })
    .catch((e) => `unavailable: ${e.message}`);
  d.aboutDebuggingWarnings = await dbg
    .evaluate(() => {
      // Expand the collapsed "Warning details" and read the message bodies.
      for (const b of document.querySelectorAll('button, summary')) if (/Warning details/.test(b.textContent)) b.click();
      const cards = [...document.querySelectorAll('.card, .debug-target-item, li')].filter((c) => c.textContent.includes('browsception firefox probe'));
      const card = cards.sort((a, b) => a.textContent.length - b.textContent.length)[0] ?? document.body;
      const msgs = [...card.querySelectorAll('.qa-message, .message, .message__body, .message__text, [class*="message"]')].map((e) => e.textContent.trim());
      return { msgs: [...new Set(msgs)], text: card.textContent.replace(/\s+/g, ' ').slice(0, 2000) };
    })
    .catch((e) => `unavailable: ${e.message}`);
  await dbg.close();
  const pass = d.page.instantiate === 42 && d.worker.wasm === 42;
  return {
    pass,
    note: `page instantiate=${short(d.page.instantiate)}, worker instantiate=${short(d.worker.wasm)}, eval (via BiDi)=${short(d.eval.eval)}, page's own script at load: ${short(d.atLoad)}; install-time warnings (stdout/stderr): ${d.installWarnings.length ? d.installWarnings.join(' | ') : '(none)'}; about:debugging warnings: ${JSON.stringify(d.aboutDebuggingWarnings?.msgs ?? d.aboutDebuggingWarnings)}`,
    detail: d,
  };
});

// 9. Harness self-check: console capture + errors surface.
probe(9, 'harness: console capture', async ({ ff, viewer }) => {
  await viewer.hookConsole();
  await viewer.evaluate(() => {
    console.log('probe-console-ok', { a: 1 });
    console.warn('probe-warn');
    setTimeout(() => {
      throw new Error('probe-uncaught');
    }, 0);
  });
  await sleep(500);
  await viewer.drainConsole();
  const seen = viewer.consoleLines.map((l) => `${l.level}:${l.text}`);
  // Same on a plain (non-extension) page, with the static redirect off.
  await viewer.evaluate(() => __probe.dnr.updateEnabledRulesets({ disableRulesetIds: ['catchall'] }));
  const plain = await ff.newPage();
  await plain.goto('https://grid.bstest/').catch(() => {});
  await plain.evaluate(() => console.log('plain-console-ok'));
  await sleep(500);
  const seenPlain = plain.consoleLines.map((l) => `${l.level}:${l.text}`);
  await plain.close();
  await viewer.evaluate(() => __probe.dnr.updateEnabledRulesets({ enableRulesetIds: ['catchall'] }));
  return {
    pass: seen.some((s) => s.includes('probe-console-ok')) && seen.some((s) => s.includes('probe-uncaught')) && seenPlain.some((s) => s.includes('plain-console-ok')),
    note: `extension page via in-page hook (BiDi log.entryAdded is silent for moz-extension pages): ${short(seen)}; plain page via BiDi: ${short(seenPlain)}`,
    detail: { seen, seenPlain },
  };
});

// -------------------------------------------------------------------- main
await waitForOwnFixtureServer();
const ff = await launchFirefox({
  extensionDir: EXT_DIR,
  profilePrefs: {
    'extensions.webextensions.uuids': JSON.stringify({ [GECKO_ID]: UUID }),
    'extensions.background.idle.timeout': 2000,
    'devtools.console.stdout.chrome': true,
    ...(args.includes('--gl') ? { 'webgl.force-enabled': true, 'webgl.disabled': false, 'gfx.webrender.software': true } : {}),
  },
});
console.log(`firefox ${ff.session.capabilities.browserVersion}; extension ${ff.extensionId} at ${ff.extensionBaseUrl}`);
const results = [];
try {
  const viewer = await ff.newPage();
  await viewer.goto(`${ff.extensionBaseUrl}viewer.html`);
  await viewer.waitForFunction('typeof __probe === "object"');
  for (const p of probes) {
    if (only && !only.includes(p.n)) continue;
    let r;
    try {
      r = await p.run({ ff, viewer });
    } catch (e) {
      r = { pass: false, note: `driver error: ${e.message}` };
    }
    results.push({ n: p.n, name: p.name, ...r });
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${p.n}. ${p.name}\n      ${r.note}`);
    if (VERBOSE && r.detail) console.log(JSON.stringify(r.detail, null, 1));
  }
} finally {
  const viewerConsole = ff.consoleLines.filter((l) => l.level !== 'info');
  if (viewerConsole.length) console.log('console (non-info):', viewerConsole.map((l) => `${l.level}: ${l.text}`).join('\n  '));
  if (VERBOSE) console.log('firefox stderr:\n' + ff.stderr.join('\n'));
  await ff.close();
}
console.log('\n| # | probe | result | observation |\n|---|---|---|---|');
for (const r of results) console.log(`| ${r.n} | ${r.name} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.note.replace(/\|/g, '\\|')} |`);
