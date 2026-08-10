#!/usr/bin/env node
// Phase-1 fixture verification through the dev harness — the pre-extension
// form of tier-2 scenarios 7 (render), 8 (execute), 9 (input) plus the 1.5
// crash/teardown checks. Fixture-only and deterministic (no real sites):
// the fixture server serves *.bstest, the dev server's /__bibproxy resolves
// those hosts to it, and the engine loads them through the fetch bridge.
// Graduates into test/tier2/ once the extension hosts the engine (2.1).
// Usage: node tools/smoke-fixtures.mjs [--headed]

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = join(ROOT, 'engine/WebkitWasm');
const PORT = 8094; // dev server
const FIXTURE_HTTP = 8096; // fixture server (offset from tier-1's 8081)
const headed = process.argv.includes('--headed');

const servers = [
  spawn('node', ['test/fixtures/server.mjs', '--http', String(FIXTURE_HTTP), '--https', '8497'], {
    cwd: ROOT,
    stdio: 'ignore',
  }),
  spawn(
    'node',
    ['tools/dev-server.mjs', 'web', '--mount', '/engine=build/webcore/bin'],
    { cwd: W, env: { ...process.env, PORT: String(PORT), BIB_BSTEST_PORT: String(FIXTURE_HTTP) }, stdio: 'ignore' },
  ),
];
process.on('exit', () => servers.forEach((s) => s.kill()));
await new Promise((resolve, reject) => {
  const t0 = Date.now();
  (async function poll() {
    try {
      await fetch(`http://127.0.0.1:${PORT}/browser.html`);
      await fetch(`http://127.0.0.1:${FIXTURE_HTTP}/__health`);
      resolve();
    } catch {
      Date.now() - t0 > 5000 ? reject(new Error('servers did not start')) : setTimeout(poll, 100);
    }
  })();
});

const browser = await chromium.launch({
  executablePath: process.env.BS_CHROMIUM ?? '/usr/bin/chromium',
  headless: !headed,
});

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    failures++;
  }
}

// One engine instance per scenario page (boot cost dominates; probes are in
// guest framebuffer px — automation runs the raster path, probes are exact).
async function bootPage(url, extraParams = '') {
  const page = await browser.newPage();
  page.consoleLines = [];
  page.on('console', (m) => page.consoleLines.push(m.text()));
  await page.goto(
    `http://127.0.0.1:${PORT}/browser.html?url=${encodeURIComponent(url)}${extraParams}`,
  );
  await page.waitForFunction(() => window.__bib && window.__bib.ready, { timeout: 120000 });
  return page;
}
const probe = (page, x, y) =>
  page.evaluate(([px, py]) => window.__bib.probe(px, py), [x, y]);
async function until(page, x, y, pred, timeoutMs = 60000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await probe(page, x, y);
    if (last && pred(last)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`probe @${x},${y} stuck at [${last}]`);
}
const is = (rgb) => (p) => p[0] === rgb[0] && p[1] === rgb[1] && p[2] === rgb[2];

// Ask the guest page a JS question via the console forwarder, retrying while
// it settles (same trick as smoke-bridge).
async function evalProbe(page, js, expect, tries = 40) {
  let last = '(no response)';
  for (let t = 0; t < tries; t++) {
    const marker = `FIX${t}_${Math.random().toString(36).slice(2, 8)}`;
    await page.evaluate(
      ([m, code]) => window.__bib.eval(`console.log(${JSON.stringify(m)} + ':' + (${code}))`),
      [marker, js],
    );
    await new Promise((r) => setTimeout(r, 500));
    const hit = page.consoleLines.find((l) => l.includes(`${marker}:`));
    if (!hit) continue;
    last = hit.slice(hit.indexOf(`${marker}:`) + marker.length + 1);
    if (expect.test(last)) return last;
  }
  throw new Error(`guest probe: ${js} -> ${last.slice(0, 200)}`);
}

// --- Scenario 7: render — grid.bstest squares land where they must --------
{
  const page = await bootPage('http://grid.bstest/');
  await check('render: grid squares + white bg', async () => {
    await until(page, 100, 100, is([255, 0, 0]), 120000); // page painted
    for (const [x, y, rgb] of [
      [300, 100, [0, 255, 0]],
      [100, 300, [0, 0, 255]],
      [300, 300, [255, 255, 0]],
      [500, 100, [0, 0, 0]],
      [700, 300, [255, 255, 255]], // background
    ]) {
      const p = await probe(page, x, y);
      if (!is(rgb)(p)) throw new Error(`@${x},${y} = [${p}], want [${rgb}]`);
    }
  });
  await page.close();
}

// --- Scenario 8: execute — app.bstest JS/timers/fetch/cookies/pushState ---
{
  const page = await bootPage('http://app.bstest/');
  const SW = { JS: 25, TIMER: 75, FETCH: 125, XFETCH: 175, COOKIE: 225, PUSHSTATE: 275 };
  for (const [name, x] of Object.entries(SW))
    await check(`execute: ${name}`, () => until(page, x, 425, is([0, 255, 0]), 120000));
  await check('execute: redirect chain lands on /final', async () => {
    await page.evaluate(() => window.__bib.eval("document.getElementById('redirlink').click()"));
    // No $ anchor: the console forwarder appends a " (:line)" suffix.
    await evalProbe(page, 'location.href', /^http:\/\/app\.bstest\/final\b/);
  });
  await page.close();
}

// --- Scenario 9: input — input.bstest pixel semantics ---------------------
{
  const page = await bootPage('http://input.bstest/');
  const box = await (await page.$('#screen')).boundingBox();
  const at = (x, y) => [box.x + x, box.y + y];

  await check('input: fixture loaded', () => until(page, 500, 100, is([0, 0, 255]), 120000));
  await check('input: click', async () => {
    await page.mouse.click(...at(100, 100));
    await until(page, 100, 100, is([0, 255, 0]));
  });
  await check('input: dblclick', async () => {
    await page.mouse.dblclick(...at(100, 100));
    await until(page, 100, 100, is([255, 136, 0]));
  });
  // Focus sits on the body after the clicks above, so 'a' is a pure keydown
  // probe (keyCode 65 -> rgb(65, 190, 64)), not field input.
  await check('input: keydown', async () => {
    await page.keyboard.press('a');
    await until(page, 300, 100, is([65, 190, 64]));
  });
  await check('input: wheel-scroll', async () => {
    await page.mouse.move(...at(600, 450)); // over the body, clear of zones
    await page.mouse.wheel(0, 800);
    await until(page, 500, 100, (p) => p[0] > 0 && p[2] < 255);
  });
  await check('input: type into field', async () => {
    await page.mouse.click(...at(95, 240));
    await page.keyboard.type('hi', { delay: 150 });
    await until(page, 100, 350, is([209, 209, 209])); // (104+105)%256
  });
  // Canvas blur -> bib_set_focus(0); refocus -> (1); typing still lands.
  await check('input: refocus and type', async () => {
    await page.click('#urlbar');
    await page.mouse.click(...at(95, 240));
    await page.keyboard.type('!', { delay: 150 });
    await until(page, 100, 350, is([242, 242, 242])); // (104+105+33)%256
  });
  await check('input: link click navigates', async () => {
    await page.mouse.click(...at(320, 350)); // #nav -> final.html (#663399)
    await until(page, 400, 300, is([102, 51, 153]), 120000);
  });
  await page.close();
}

// --- 1.5 crash path: engine abort -> dead UI -> reload recovers -----------
{
  const page = await bootPage('http://grid.bstest/');
  await check('crash: abort -> teardown UI', async () => {
    await until(page, 100, 100, is([255, 0, 0]), 120000);
    await page.evaluate(() => Module._bib_crash());
    await page.waitForFunction(() => window.__bib.dead === true, { timeout: 30000 });
    const state = await page.evaluate(() => ({
      status: document.getElementById('status').textContent,
      urlbar: document.getElementById('urlbar').disabled,
      go: document.getElementById('gobtn').disabled,
    }));
    if (!/CRASHED/.test(state.status)) throw new Error(`status: ${state.status}`);
    if (!state.urlbar || !state.go) throw new Error('controls not disabled');
  });
  await check('crash: reload recovers', async () => {
    await page.reload();
    await page.waitForFunction(() => window.__bib && window.__bib.ready, { timeout: 120000 });
    await until(page, 100, 100, is([255, 0, 0]), 120000);
  });
  await page.close();
}

// --- 1.5 hang path: worker death (no abort signal) -> heartbeat Reload ----
{
  const page = await bootPage('http://grid.bstest/', '&hbms=2000');
  await check('hang: heartbeat detects dead worker', async () => {
    await until(page, 100, 100, is([255, 0, 0]), 120000);
    await page.evaluate(() => window.__bib.killEngine());
    await page.waitForFunction(
      () => {
        const ov = document.getElementById('bibfreeze');
        return (
          ov.style.display !== 'none' &&
          document.getElementById('bibfreeze-msg').textContent.includes('unresponsive') &&
          document.getElementById('bibfreeze-reload').style.display !== 'none'
        );
      },
      { timeout: 30000 },
    );
  });
  await page.close();
}

await browser.close();
servers.forEach((s) => s.kill());
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
