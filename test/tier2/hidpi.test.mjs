// Tier 2 — HiDPI: everything that crosses the CSS px / logical px / device px
// boundary, exercised at dpr != 1.
//
// Why a whole file: at dpr 1 the three coordinate spaces are numerically
// IDENTICAL, so no dpr-1 test can tell them apart and a unit mix-up (device
// px handed to an API that wants logical px) passes the entire suite. That is
// exactly how mouse input shipped scaled by dpr — every click landing dpr
// times too far down and right on a HiDPI screen, while scenario 14's "input
// stays aligned" stayed green. Everything here probes far enough from the
// origin that a scale error cannot land on the right target by luck.
//
// Two dprs: 2 (integer — exact device/logical arithmetic) and 1.5 (fractional
// — the rounding paths: snapped scroll shifts, enclosing damage rects, cull
// inflation). Each needs its own browser: device scale factor is a launch
// property, and it must be --force-device-scale-factor rather than
// playwright's deviceScaleFactor option (see launchAt).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import {
  CHROMIUM_BIN,
  RESOLVER_RULES,
  extensionId,
  requireStagedEngine,
  waitForFixtureServer,
} from '../harness/launch.mjs';

const DPRS = [2, 1.5];
const EXT_DIR = new URL('../../src', import.meta.url).pathname;
requireStagedEngine(EXT_DIR);
const FIXTURE_BLACKLIST = ['grid.bstest', 'input.bstest', 'app.bstest', 'other.bstest', 'hostile.bstest'];
const BOOT_TIMEOUT = 120000;

const fixtures = spawn('node', [new URL('../fixtures/server.mjs', import.meta.url).pathname], {
  stdio: 'ignore',
});
await waitForFixtureServer();

// --force-device-scale-factor, NOT playwright's deviceScaleFactor option: the
// latter reports dpr N to JS while leaving device-pixel-content-box and the
// compositing surface at 1x, so the viewer sizes a 1x framebuffer and the very
// mix-up this file exists to catch cancels itself out. The flag reproduces a
// real HiDPI screen (verified: dpcb = N × the CSS box, as on hardware).
async function launchAt(dpr) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'bs-hidpi-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROMIUM_BIN,
    headless: true,
    viewport: null, // no metrics emulation on top of the forced scale factor
    ignoreHTTPSErrors: true,
    args: [
      `--force-device-scale-factor=${dpr}`,
      '--window-size=1280,720',
      `--host-resolver-rules=${RESOLVER_RULES}`,
      '--ignore-certificate-errors',
      '--no-first-run',
      '--disable-background-networking',
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
    ],
  });
  // Unpacked ids are hashed from the load path — ask the running extension.
  const extId = await extensionId(context);
  const cfg = await context.newPage();
  await cfg.goto(`chrome-extension://${extId}/ext/viewer.html?stub=1`);
  await cfg.evaluate((p) => chrome.storage.sync.set(p), {
    active: true,
    mode: 'blacklist',
    blacklist: FIXTURE_BLACKLIST,
    whitelist: [],
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const ready = await cfg.evaluate(() =>
      chrome.declarativeNetRequest.getDynamicRules().then((r) => r.length >= 4),
    );
    if (ready) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await cfg.close();
  return {
    context,
    extId,
    close: async () => {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

// One browser per dpr, built on first use (tests run sequentially).
const sessions = new Map();
const sessionAt = (dpr) => {
  if (!sessions.has(dpr)) sessions.set(dpr, launchAt(dpr));
  return sessions.get(dpr);
};
test.after(async () => {
  for (const pending of sessions.values()) await (await pending).close();
  fixtures.kill();
});

async function bootViewer(dpr, target) {
  const { context, extId } = await sessionAt(dpr);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ext/viewer.html?url=${encodeURIComponent(target)}`);
  await page.waitForFunction(() => globalThis.__bs?.ready, undefined, { timeout: BOOT_TIMEOUT });
  assert.equal(await page.evaluate(() => devicePixelRatio), dpr, 'page really is HiDPI');
  return page;
}

// __bs.probe takes DEVICE px; fixture geometry is LOGICAL px; playwright's
// mouse takes CSS px (same scale as logical, offset by the canvas position).
const probe = (page, x, y) => page.evaluate(([px, py]) => __bs.probe(px, py), [x, y]);
const probeLogical = (page, dpr, lx, ly) => probe(page, Math.round(lx * dpr), Math.round(ly * dpr));
async function until(page, dpr, lx, ly, pred, timeoutMs, what) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await probeLogical(page, dpr, lx, ly);
    if (last && pred(last)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${what} @logical ${lx},${ly} stuck at [${last}]`);
}
const is = (rgb) => (p) => p[0] === rgb[0] && p[1] === rgb[1] && p[2] === rgb[2];
// Canvas origin in CSS px, so mouse coordinates below can be written in
// fixture (logical) coordinates.
const canvasOrigin = async (page) => {
  const box = await (await page.$('#screen')).boundingBox();
  return (x, y) => [box.x + x, box.y + y];
};

for (const dpr of DPRS) {
  test(`hidpi ${dpr}x: framebuffer is device px, layout is logical px`, { timeout: 300000 }, async () => {
    const page = await bootViewer(dpr, 'https://input.bstest/');
    await until(page, dpr, 500, 100, is([0, 0, 255]), 120000, 'fixture load');
    const geom = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return { fb: __bs.fb, w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight };
    });
    assert.equal(geom.fb.w, geom.w, 'canvas backing store == framebuffer');
    assert.ok(Math.abs(geom.w - geom.cw * dpr) <= 1, `backing ${geom.w} ≈ ${geom.cw} CSS px × ${dpr}`);
    assert.ok(Math.abs(geom.h - geom.ch * dpr) <= 1, `backing ${geom.h} ≈ ${geom.ch} CSS px × ${dpr}`);
    // The fixture's zones are 200 LOGICAL px wide, so the scroll zone
    // (logical x 400-600) covers device x 400*dpr..600*dpr: finding it at its
    // device-space center proves the engine really painted at dpr scale.
    assert.ok(
      is([0, 0, 255])(await probe(page, Math.round(500 * dpr), Math.round(100 * dpr))),
      'scroll zone sits at dpr-scaled device coordinates',
    );
    await page.close();
  });

  test(`hidpi ${dpr}x: mouse coordinates map CSS px -> engine logical px`, { timeout: 300000 }, async () => {
    const page = await bootViewer(dpr, 'https://input.bstest/');
    const at = await canvasOrigin(page);
    await until(page, dpr, 500, 100, is([0, 0, 255]), 120000, 'fixture load');

    // Center of the 200x200 click zone. Misread as device px this is
    // (150*dpr, 150*dpr): outside every zone at 1.5x, squarely on the nav
    // link (which navigates away) at 2x. A scale error cannot pass here.
    await page.mouse.click(...at(150, 150));
    await until(page, dpr, 100, 100, is([0, 255, 0]), 60000, 'click at CSS 150,150 hits the click zone');
    await page.mouse.dblclick(...at(150, 150));
    await until(page, dpr, 100, 100, is([255, 136, 0]), 60000, 'dblclick');
    // The key zone reacts to keydown only: still at its base color proves
    // nothing stray was typed and nothing else was hit.
    assert.ok(is([32, 32, 32])(await probeLogical(page, dpr, 300, 100)), 'key zone untouched');

    // Wheel position selects the scroller under the cursor; then click the
    // text field (fixed, logical y 220-260) and type into it.
    await page.mouse.move(...at(600, 450));
    await page.mouse.wheel(0, 800);
    await until(page, dpr, 500, 100, (p) => p[0] > 0 && p[2] < 255, 60000, 'wheel scrolled the page');
    await page.mouse.click(...at(95, 240));
    await page.keyboard.type('hi', { delay: 150 });
    await until(page, dpr, 100, 350, is([209, 209, 209]), 60000, 'typing reached the field under the click');

    // Link hit-testing end to end: nav link spans logical (220,300)-(420,400).
    await page.mouse.click(...at(320, 350));
    await until(page, dpr, 400, 300, is([102, 51, 153]), 120000, 'link navigation');
    await page.close();
  });

  test(`hidpi ${dpr}x: input stays aligned across a resize`, { timeout: 300000 }, async () => {
    const page = await bootViewer(dpr, 'https://input.bstest/');
    const { context } = await sessionAt(dpr);
    await until(page, dpr, 500, 100, is([0, 0, 255]), 120000, 'fixture load');
    // Resize the real window: playwright's setViewportSize would start
    // metrics emulation and override the forced device scale factor.
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 900, height: 640 } });
    const t0 = Date.now(); // the engine adopts it after the 100 ms debounce + realloc
    while (Date.now() - t0 < 30000) {
      const settled = await page.evaluate((d) => {
        const c = document.querySelector('canvas');
        return __bs.fb && Math.abs(__bs.fb.w - c.clientWidth * d) <= 1;
      }, dpr);
      if (settled) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const at = await canvasOrigin(page);
    await page.mouse.click(...at(150, 150));
    await until(page, dpr, 100, 100, is([0, 255, 0]), 60000, 'click lands after resize');
    await page.close();
  });
}
