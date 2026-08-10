#!/usr/bin/env node
// 1.5 leak check: 50 engine navigations across the fixture pages, sampling
// the wasm heap after each. The reserved heap (HEAPU8.length) only ever
// grows, so the leak signal is growth that never flattens — a per-navigation
// leak of any size shows as steady late-run growth. Bounds are generous
// tripwires, not perf targets. Usage: node tools/smoke-leak.mjs [--navs N]
//
// Deterministic + fixture-only, same server setup as smoke-fixtures.mjs.

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = join(ROOT, 'engine/WebkitWasm');
const PORT = 8095;
const FIXTURE_HTTP = 8097;
const navsArg = process.argv.indexOf('--navs');
const NAVS = navsArg >= 0 ? Number(process.argv[navsArg + 1]) : 50;

const servers = [
  spawn('node', ['test/fixtures/server.mjs', '--http', String(FIXTURE_HTTP), '--https', '8498'], {
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
  headless: !process.argv.includes('--headed'),
});
const page = await browser.newPage();

// Each stop has a pixel signature to await, so "navigation done" is cheap.
const STOPS = [
  { url: 'http://grid.bstest/', x: 100, y: 100, rgb: [255, 0, 0] },
  { url: 'http://input.bstest/', x: 500, y: 100, rgb: [0, 0, 255] },
  { url: 'http://app.bstest/', x: 25, y: 425, rgb: [0, 255, 0] }, // JS swatch
];

await page.goto(`http://127.0.0.1:${PORT}/browser.html?url=${encodeURIComponent(STOPS[0].url)}`);
await page.waitForFunction(() => window.__bib && window.__bib.ready, { timeout: 120000 });

const probe = (x, y) => page.evaluate(([px, py]) => window.__bib.probe(px, py), [x, y]);
async function untilPixel({ x, y, rgb }, timeoutMs = 60000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await probe(x, y);
    if (last && last[0] === rgb[0] && last[1] === rgb[1] && last[2] === rgb[2]) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`nav stuck: probe @${x},${y} = [${last}], want [${rgb}]`);
}

await untilPixel(STOPS[0], 120000);
const heap = () => page.evaluate(() => Module.HEAPU8.length);
const MB = (n) => (n / 1048576).toFixed(1);
const samples = [await heap()];
console.log(`boot heap: ${MB(samples[0])} MB`);

for (let i = 1; i <= NAVS; i++) {
  const stop = STOPS[i % STOPS.length];
  await page.evaluate((u) => Module.ccall('bib_load_url', null, ['string'], [u]), stop.url);
  await untilPixel(stop);
  samples.push(await heap());
  if (i % 10 === 0) console.log(`after nav ${i}: ${MB(samples[i])} MB`);
}

const finalHeap = samples[samples.length - 1];
const lateGrowth = finalHeap - samples[Math.floor(samples.length / 2)];
console.log(
  `final: ${MB(finalHeap)} MB reserved (boot ${MB(samples[0])}, ` +
    `growth ${MB(finalHeap - samples[0])}, second-half growth ${MB(lateGrowth)})`,
);

let failures = 0;
if (finalHeap > 2.5 * 1024 ** 3) {
  console.log(`FAIL heap-cap: ${MB(finalHeap)} MB reserved after ${NAVS} navs`);
  failures++;
} else if (lateGrowth > 256 * 1024 ** 2) {
  console.log(`FAIL leak: second-half growth ${MB(lateGrowth)} MB — heap never flattens`);
  failures++;
} else {
  console.log('PASS leak-check');
}

await browser.close();
servers.forEach((s) => s.kill());
process.exit(failures ? 1 : 0);
