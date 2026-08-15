// Scroll-SPEED probe: does scrolling *faster* cost superlinearly?
//
// Drives the viewer canvas with synthetic wheel events at a controlled
// (events-per-frame x px-per-event) rate, and measures what actually came
// out: presented frames, engine-thread busy%, how far the page really
// scrolled, and how long the engine kept scrolling AFTER input stopped
// (backlog / latency).
//
// Scroll offset is read from the pixels: the scroll.bstest fixture gives every
// 120px section a colour-coded left border (r = idx&255, g = idx>>8), so
// __bs.probe(4,4) decodes to a scroll offset without asking the guest page.
//
// Usage: node tools/scroll-speed-probe.mjs [--dpr 1] [--url URL]
//        [--secs 4] [--sweep "px/frame,..."] [--epf N] [--headed]
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, extensionIdFromManifest, waitForFixtureServer } from '../test/harness/launch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '../src');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const dpr = Number(arg('dpr', '1'));
const secs = Number(arg('secs', '4'));
const target = arg('url', 'https://scroll.bstest/');
const epf = Number(arg('epf', '1')); // wheel events dispatched per host frame
const stride = Number(arg('stride', '1')); // dispatch only every Nth frame (delta x N)
const sweep = arg('sweep', '60,120,240,480,960,1920')
  .split(',')
  .map(Number); // px of scroll per host frame

const usesFixture = target.includes('.bstest');
const fixtures = usesFixture
  ? spawn('node', [join(HERE, '../test/fixtures/server.mjs')], { stdio: 'ignore' })
  : null;
if (fixtures) await waitForFixtureServer();

const session = await launch({ extensionDir: EXT, headless: !has('headed'), needsEngine: true });
const EXT_ID = extensionIdFromManifest(EXT);
const page = await session.context.newPage();
const [vw, vh] = arg('size', '1600x900').split('x').map(Number);
await page.setViewportSize({ width: vw, height: vh });
if (dpr !== 1) {
  const cdp = await session.context.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: vw, height: vh, deviceScaleFactor: dpr, mobile: false,
  });
}
const perfLines = [];
page.on('console', (m) => {
  const t = m.text();
  if (/BIB(PERF|SCROLL|DMG|REPAINT)/.test(t)) perfLines.push({ t, at: Date.now() });
});
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto(
  // url= is RAW (the DNR \0 contract; viewer and sweep both slice it
  // un-decoded) — an encoded url makes the SW sweep tabs.update the viewer
  // to a relative garbage URL and the probe never boots.
  // --dmglog: per-rect damage tracing (BIBDMG lines; very chatty).
  `chrome-extension://${EXT_ID}/ext/viewer.html?perflog=1${has('dmglog') ? '&dmglog=1' : ''}&persist=0&url=${target}`,
);
await page.waitForFunction(
  () => globalThis.__bs?.ready && __bs.state.progress >= 1 && /^https?:/.test(__bs.state.url ?? ''),
  null,
  { timeout: 300000 },
);
await page.waitForTimeout(2500); // let load settle
console.log('fb =', JSON.stringify(await page.evaluate(() => __bs.fb)), 'devicePixelRatio =', await page.evaluate(() => devicePixelRatio));

// --- in-page instrumentation ----------------------------------------------
await page.evaluate(() => {
  const M = window.Module;
  const P = (globalThis.__perf = {
    wheelCalls: 0, wheelPx: 0, tickCalls: 0,
    frameTs: [], // performance.now() of each presented frame
    wheelTs: [], // when a coalesced wheel actually reached the engine
    dispatched: 0, dispatchedPx: 0,
    offsets: [], // [t, offsetPx]
    running: false,
  });
  const rawWheel = M._bib_wheel.bind(M);
  M._bib_wheel = (x, y, dx, dy, mods) => {
    P.wheelCalls++; P.wheelPx += Math.abs(dy); P.wheelTs.push([performance.now(), dy]);
    return rawWheel(x, y, dx, dy, mods);
  };
  const rawTick = M._bib_tick.bind(M);
  M._bib_tick = () => { P.tickCalls++; return rawTick(); };
  const bs = globalThis.__bs;
  const rawFrame = Module.bibFrame;
  // viewer's bibFrame lives on Module; count presentations with timestamps.
  Module.bibFrame = function (...a) { P.frameTs.push(performance.now()); return rawFrame.apply(this, a); };
  P.reset = () => {
    P.wheelCalls = P.wheelPx = P.tickCalls = P.dispatched = P.dispatchedPx = 0;
    P.frameTs.length = 0; P.wheelTs.length = 0; P.offsets.length = 0;
  };
  // Pixel-decoded scroll offset sampler (5 Hz).
  P.sampleOffset = async () => {
    const px = await bs.probe(4, 4);
    if (!px) return null;
    const idx = px[0] + (px[1] << 8);
    return idx * 120;
  };
});

async function sampler(page, ms) {
  // Samples the pixel-encoded offset until stopped; returns [t, offset][].
  return page.evaluate(async (ms) => {
    const P = globalThis.__perf;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const off = await P.sampleOffset();
      P.offsets.push([performance.now(), off]);
      await new Promise((r) => setTimeout(r, 200));
    }
    return P.offsets.slice();
  }, ms);
}

async function drive({ pxPerFrame, epf, secs, stride }) {
  await page.evaluate(() => globalThis.__perf.reset());
  // Scroll back to the top and let it settle so every run starts equal.
  await page.evaluate(async () => {
    const P = globalThis.__perf;
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const jump = () => c.dispatchEvent(new WheelEvent('wheel', { deltaY: -1e7,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
    // One huge negative delta pins the engine at offset 0 in a single scroll.
    for (let i = 0; i < 5; i++) { jump(); await new Promise((r) => requestAnimationFrame(r)); }
    // Wait for offset 0 AND a quiet frame counter, so no run inherits a backlog.
    const t0 = performance.now();
    while (performance.now() - t0 < 8000) {
      const off = await P.sampleOffset();
      const n = P.frameTs.length;
      await new Promise((r) => setTimeout(r, 400));
      if (off === 0 && P.frameTs.length === n) break;
    }
  });
  await page.evaluate(() => globalThis.__perf.reset());

  // The offset sampler costs the engine a full-frame readback per sample —
  // --nosample measures fps without that perturbation.
  const samplerP = has('nosample') ? Promise.resolve([]) : sampler(page, secs * 1000 + 4000);
  const nodeStart = Date.now();
  await page.evaluate(
    async ({ pxPerFrame, epf, secs, stride }) => {
      const P = globalThis.__perf;
      const c = document.getElementById('screen');
      // Centre of the canvas: a corner can land on a page's own scrollable
      // sidebar (Wikipedia's sticky nav), which scrolls THAT instead.
      const r = c.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const per = (pxPerFrame * stride) / epf;
      const end = performance.now() + secs * 1000;
      P.inputStart = performance.now();
      let frame = 0;
      while (performance.now() < end) {
        for (let i = 0; frame % stride === 0 && i < epf; i++) {
          c.dispatchEvent(new WheelEvent('wheel', {
            deltaY: per, deltaMode: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true,
          }));
          P.dispatched++; P.dispatchedPx += per;
        }
        frame++;
        await new Promise((r) => requestAnimationFrame(r));
      }
      P.inputEnd = performance.now();
    },
    { pxPerFrame, epf, secs, stride },
  );
  const nodeEnd = Date.now();
  const offsets = await samplerP;
  const P = await page.evaluate(() => {
    const P = globalThis.__perf;
    return {
      wheelCalls: P.wheelCalls, wheelPx: P.wheelPx, tickCalls: P.tickCalls,
      dispatched: P.dispatched, dispatchedPx: P.dispatchedPx,
      frameTs: P.frameTs.slice(), wheelTs: P.wheelTs.slice(),
      inputStart: P.inputStart, inputEnd: P.inputEnd,
    };
  });
  return { ...P, offsets, nodeStart, nodeEnd };
}

const results = [];
for (const pxPerFrame of sweep) {
  perfLines.length = 0;
  const r = await drive({ pxPerFrame, epf, secs, stride });
  const during = r.frameTs.filter((t) => t >= r.inputStart && t <= r.inputEnd).length;
  const after = r.frameTs.filter((t) => t > r.inputEnd).length;
  const offs = r.offsets.filter((o) => o[1] !== null);
  const atEnd = offs.filter((o) => o[0] <= r.inputEnd).pop();
  const final = offs[offs.length - 1];
  // when did the offset stop moving after input ended?
  let settleMs = 0;
  for (let i = offs.length - 1; i > 0; i--) {
    if (offs[i][1] !== offs[i - 1][1]) { settleMs = Math.max(0, offs[i][0] - r.inputEnd); break; }
  }
  const inputSecs = (r.inputEnd - r.inputStart) / 1000;
  const row = {
    pxPerFrame, epf, stride,
    dispatched: r.dispatched,
    dispatchedPx: Math.round(r.dispatchedPx),
    wheelCalls: r.wheelCalls,
    wheelPx: Math.round(r.wheelPx),
    ticks: r.tickCalls,
    fpsDuring: +(during / inputSecs).toFixed(1),
    framesAfterInput: after,
    scrolledAtInputEnd: atEnd ? atEnd[1] : null,
    scrolledFinal: final ? final[1] : null,
    tailScrollMs: Math.round(settleMs),
  };
  row.efficiency = row.dispatchedPx ? +(row.scrolledFinal / row.dispatchedPx).toFixed(3) : null;
  // Engine-thread BIBPERF windows that closed inside the input window.
  const num = (t, re) => { const m = t.match(re); return m ? Number(m[1]) : null; };
  const win = perfLines
    .filter((l) => l.at >= r.nodeStart + 500 && l.at <= r.nodeEnd + 300 && l.t.includes('BIBPERF'))
    .map((l) => ({
      busy: num(l.t, /busy=(-?[\d.]+)%/),
      painted: num(l.t, /painted=(\d+)/),
      ticks: num(l.t, /ticks=(\d+)/),
      paint: num(l.t, /paint=([\d.]+)/),
      wheel: num(l.t, /wheel=([\d.]+)/),
      wheelN: num(l.t, /wheel=[\d.]+\(n(\d+)/),
      q: num(l.t, /q(\d+)\)/),
      blit: num(l.t, /blit=([\d.]+)/),
      mv: num(l.t, /\(mv([\d.]+)/),
      wr: num(l.t, /wr([\d.]+)/),
      blitN: num(l.t, /n(\d+) fb/),
      fb: num(l.t, /fb(\d+)/),
      rows: num(l.t, /rows(\d+)/),
    }));
  const avg = (k) => (win.length ? +(win.reduce((a, w) => a + (w[k] ?? 0), 0) / win.length).toFixed(1) : null);
  Object.assign(row, {
    engBusy: avg('busy'), engPainted: avg('painted'), engTicks: avg('ticks'),
    engPaintMs: avg('paint'), engWheelMs: avg('wheel'), engWheelN: avg('wheelN'),
    engQueueMax: win.length ? Math.max(...win.map((w) => w.q ?? 0)) : null,
    engBlitMs: avg('blit'), engBlitMoveMs: avg('mv'), engBlitWriteMs: avg('wr'), engBlitN: avg('blitN'), engBlitFallback: avg('fb'),
    engBlitRows: avg('rows'),
  });
  results.push(row);
  console.log(JSON.stringify(row));
  for (const l of perfLines) console.log('   ', l.t);
}

console.log('\n=== summary (dpr=%s, url=%s, epf=%d, stride=%d) ===', dpr, target, epf, stride);
console.table(results);
await session.close();
fixtures?.kill();
