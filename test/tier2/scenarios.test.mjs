// Tier 2 — full integration: headless Chromium + the real extension + the
// real wasm engine + fixture server (notes/testing.md scenarios; graduated
// from tools/smoke-fixtures.mjs at 2.1). Needs staged engine artifacts
// (tools/stage-engine.mjs); run via `npm run test:tier2` (per-merge/nightly,
// not per-commit).
//
// Scenarios here: 7 render, 8 execute, 9 input, 12 crash/recovery, 13
// startup budget. 10 (navigation chrome) and 11 (invariants) land with
// 2.3/2.5.

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

// --- Scenario 13: startup budget (regression tripwire, generous) -----------
test('startup: warm boot to interactive under 15 s', { timeout: 300000 }, async () => {
  // Second+ boot in this profile = warm (compiled-wasm cache, if any).
  const page = await bootViewer('https://grid.bstest/');
  const ms = await page.evaluate(() => __bs.metrics.bootMs);
  console.log(`      warm bootMs: ${ms}`);
  assert.ok(ms < 15000, `warm boot ${ms} ms exceeds 15 s tripwire`);
  await page.close();
});
