// Scroll round-trip pixel check at fractional dpr: top screenshot -> scroll
// down (many small deltas, exercises snap residual) -> scroll back -> settle
// -> screenshot. Byte-identical == no smear left behind. Expect exact at
// fractional dpr (settle repaint); at dpr 1/2 a handful of header text-AA
// specks remain (pre-existing partial-repaint noise floor, 2026-08-11).
// Usage: node scripts/scroll-roundtrip.mjs [url] [dpr]
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, extensionId } from '../test/harness/launch.mjs';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '../src');
const target = process.argv[2] ?? 'https://loginasroot.net/';
const dpr = Number(process.argv[3] ?? '1.5');

const session = await launch({ extensionDir: EXT, headless: true });
const { context } = session;
const EXT_ID = await extensionId(session.context);
const page = await context.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
if (dpr !== 1) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: dpr, mobile: false });
}
const perfLines = [];
page.on('console', (m) => { const t = m.text(); if (t.includes('BIBSCROLL') || t.includes('BIBPERF')) perfLines.push(t); });
await page.goto(`chrome-extension://${EXT_ID}/ext/viewer.html?perflog=1&persist=0&url=${target}`);
await page.waitForFunction(() => globalThis.__bs?.ready && __bs.state.progress >= 1 && /^https?:/.test(__bs.state.url ?? ''), null, { timeout: 90000 });
await page.waitForTimeout(2500);

const canvas = await page.$('#screen');
const box = await canvas.boundingBox();
// park the pointer BEFORE the reference shot so hover state matches; wait
// until the hover repaint has actually presented (frames advance), then for
// a quiet period (no new frames = page settled).
const framesNow = await page.evaluate(() => __bs.frames);
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForFunction((n) => __bs.frames > n, framesNow, { timeout: 5000 }).catch(() => {});
for (;;) {
  const f0 = await page.evaluate(() => __bs.frames);
  await page.waitForTimeout(700);
  if ((await page.evaluate(() => __bs.frames)) === f0) break;
}
const shotA = await canvas.screenshot();
// 60 x 13px down, then 60 x 13px up: odd delta at fractional dpr => residual churn
for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, 13); await page.waitForTimeout(8); }
await page.waitForTimeout(600); // settle repaint (200ms) + margin
const shotMid = await canvas.screenshot();
for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, -13); await page.waitForTimeout(8); }
// extra to guarantee we're pinned at top
for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(8); }
await page.waitForTimeout(600);
const shotB = await canvas.screenshot();

const same = Buffer.compare(shotA, shotB) === 0;
console.log(`dpr=${dpr} roundtrip identical: ${same} (A=${shotA.length}B B=${shotB.length}B, mid different: ${Buffer.compare(shotA, shotMid) !== 0})`);
if (!same) {
  const fs = await import('node:fs');
  const dir = process.env.TMPDIR ?? '/tmp';
  fs.writeFileSync(`${dir}/rt-A-${dpr}.png`, shotA);
  fs.writeFileSync(`${dir}/rt-B-${dpr}.png`, shotB);
  console.log(`wrote ${dir}/rt-{A,B}-${dpr}.png`);
}
const fallbacks = perfLines.filter((l) => l.includes('fallback')).length;
const blits = perfLines.filter((l) => l.includes('delta=')).length;
const settles = perfLines.filter((l) => l.includes('settle')).length;
console.log(`blit calls: ${blits}, full-repaint fallbacks: ${fallbacks}, settle repaints: ${settles}`);
await session.close();
