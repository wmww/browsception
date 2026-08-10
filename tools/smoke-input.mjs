#!/usr/bin/env node
// 1.4 milestone check: mouse/wheel/keyboard reach the guest page through the
// dev harness (canvas capture -> bib_* exports -> WebCore EventHandler),
// asserted against input.html's pixel semantics (test/fixtures/pages/, served
// through a dev-server mount and loaded via the fetch bridge). Fixture-only
// and deterministic — unlike smoke-bridge.mjs this touches no real sites; it
// graduates into tier-2 scenario 9 once the extension hosts the engine (2.1).
// Usage: node tools/smoke-input.mjs [--headed]

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = join(ROOT, 'engine/WebkitWasm');
const PORT = 8094;
const headed = process.argv.includes('--headed');

// Dev server: harness + /__bibproxy + the engine build + the fixture pages.
const server = spawn(
  'node',
  ['tools/dev-server.mjs', 'web',
    '--mount', '/engine=build/webcore/bin',
    '--mount', `/fixtures=${join(ROOT, 'test/fixtures/pages')}`],
  { cwd: W, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' },
);
process.on('exit', () => server.kill());
await new Promise((resolve, reject) => {
  const t0 = Date.now();
  (async function poll() {
    try {
      await fetch(`http://127.0.0.1:${PORT}/browser.html`);
      resolve();
    } catch {
      Date.now() - t0 > 5000 ? reject(new Error('dev server did not start')) : setTimeout(poll, 100);
    }
  })();
});

const browser = await chromium.launch({
  executablePath: process.env.BS_CHROMIUM ?? '/usr/bin/chromium',
  headless: !headed,
});
const page = await browser.newPage();

const fixtureURL = `http://127.0.0.1:${PORT}/fixtures/input.html`;
await page.goto(`http://127.0.0.1:${PORT}/browser.html?url=${encodeURIComponent(fixtureURL)}`);
await page.waitForFunction(() => window.__bib && window.__bib.ready, { timeout: 120000 });

// Pixel probes in GUEST framebuffer coordinates (engine renders unpremul
// RGBA; automation runs the raster path, so probes are exact).
const probe = (x, y) => page.evaluate(([px, py]) => window.__bib.probe(px, py), [x, y]);
async function until(name, x, y, pred, timeoutMs = 60000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await probe(x, y);
    if (last && pred(last)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`probe @${x},${y} stuck at [${last}]`);
}
const is = (rgb) => (p) => p[0] === rgb[0] && p[1] === rgb[1] && p[2] === rgb[2];

// Host-page coordinates of a guest framebuffer point (canvas is 1:1 CSS px).
const box = await (await page.$('#screen')).boundingBox();
const at = (x, y) => [box.x + x, box.y + y];

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

// Zone centers (see input.html's header comment).
await check('fixture-loaded', () => until('load', 500, 100, is([0, 0, 255]), 120000));

await check('click', async () => {
  await page.mouse.click(...at(100, 100));
  await until('click', 100, 100, is([0, 255, 0]));
});

await check('dblclick', async () => {
  await page.mouse.dblclick(...at(100, 100));
  await until('dblclick', 100, 100, is([255, 136, 0]));
});

// Focus sits on the body after the clicks above, so 'a' is a pure keydown
// probe (keyCode 65 -> rgb(65, 190, 64)), not field input.
await check('keydown', async () => {
  await page.keyboard.press('a');
  await until('keydown', 300, 100, is([65, 190, 64]));
});

await check('wheel-scroll', async () => {
  await page.mouse.move(...at(600, 450)); // over the page body, clear of zones
  await page.mouse.wheel(0, 800);
  // scroll zone: rgb(min(255, scrollY/10), 0, 255-…) — assert it moved.
  await until('scroll', 500, 100, (p) => p[0] > 0 && p[2] < 255);
});

await check('type-into-field', async () => {
  await page.mouse.click(...at(95, 240));
  await page.keyboard.type('hi', { delay: 150 });
  await until('sum', 100, 350, is([209, 209, 209])); // (104+105)%256
});

// Canvas blur -> bib_set_focus(0); refocus -> (1); typing still lands.
await check('refocus-and-type', async () => {
  await page.click('#urlbar');
  await page.mouse.click(...at(95, 240));
  await page.keyboard.type('!', { delay: 150 });
  await until('sum', 100, 350, is([242, 242, 242])); // (104+105+33)%256
});

await check('link-click-navigates', async () => {
  await page.mouse.click(...at(320, 350)); // #nav -> final.html (#663399)
  await until('nav', 400, 300, is([102, 51, 153]), 120000);
});

await browser.close();
server.kill();
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
