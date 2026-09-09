// Scroll-perf probe: real engine + real site, perflog=1, synthesized wheel.
// Findings 2026-08-11 in notes/rendering-input.md § scrolling + notes/experiment-log.md.
// Usage: node scripts/perf-scroll-probe.mjs [url] [dpr]
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, extensionIdFromManifest } from '../test/harness/launch.mjs';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '../src');
const target = process.argv[2] ?? 'https://loginasroot.net/';
const dpr = Number(process.argv[3] ?? '1');

const session = await launch({ extensionDir: EXT, headless: true });
const { context } = session;
const EXT_ID = extensionIdFromManifest(EXT);

const page = await context.newPage();
await page.setViewportSize({ width: 1600, height: 900 });
if (dpr !== 1) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 900, deviceScaleFactor: dpr, mobile: false,
  });
}
const perfLines = [];
page.on('console', (msg) => {
  const t = msg.text();
  if (t.includes('BIBPERF') || t.includes('BIBSCROLL') || t.includes('perflog')) perfLines.push(t);
});

await page.goto(`chrome-extension://${EXT_ID}/ext/viewer.html?perflog=1&persist=0&url=${target}`);
// wait engine ready + page loaded
await page.waitForFunction(() => globalThis.__bs?.ready && __bs.state.progress >= 1 && /^https?:/.test(__bs.state.url ?? ''), null, { timeout: 90000 });
await page.waitForTimeout(2000); // settle

const framesBefore = await page.evaluate(() => __bs.frames);
const t0 = Date.now();

// ~120 Hz trackpad-ish wheel: deltaY 16 per event for 5 s over the canvas
const box = await (await page.$('#screen')).boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
const END = Date.now() + 5000;
let sent = 0;
while (Date.now() < END) {
  await page.mouse.wheel(0, 16);
  sent++;
  await page.waitForTimeout(4); // ~120/s best case
}
const elapsed = (Date.now() - t0) / 1000;
await page.waitForTimeout(1500); // let engine drain
const framesAfter = await page.evaluate(() => __bs.frames);
const fb = await page.evaluate(() => __bs.fb);

console.log(`\n=== target=${target} dpr(request)=${dpr} fb=${JSON.stringify(fb)}`);
console.log(`wheel events sent: ${sent} over ${elapsed.toFixed(1)}s`);
console.log(`frames presented during+after scroll: ${framesAfter - framesBefore} (${((framesAfter - framesBefore) / (elapsed + 1.5)).toFixed(1)} fps)`);
console.log('\n--- BIBPERF lines ---');
for (const l of perfLines) console.log(l);

await session.close();
