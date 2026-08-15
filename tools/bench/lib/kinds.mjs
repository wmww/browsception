// One measurement procedure per scenario kind. Each returns a rep:
//   { metrics, extra, notes[], invalid: string|null }
//
// The measurement protocol here is notes/perf-measurement.md § Traps codified:
// reset to a known state, discard a warm-up window, keep readbacks OUT of the
// measured window (they cost a full-frame readback each), and read the
// end state from pixels so "fast because it stopped painting correctly"
// cannot pass as an improvement.

import { aggregateWindows, parseBibperf } from './bibperf.mjs';
import { median, p95 } from './report.mjs';
import { bootProbe, installBench } from './page.mjs';

const WARMUP_MS = 1000;

/** BIBPERF windows that closed inside the measured interval (wall clock). */
export function engineWindows(perfLines, nodeStart, nodeEnd) {
  return perfLines
    .filter((l) => l.at >= nodeStart + 900 && l.at <= nodeEnd + 250)
    .map((l) => parseBibperf(l.text))
    .filter(Boolean);
}

function hostMetrics(snap, secs) {
  return {
    hostFps: snap.frames / secs,
    hostPresentMsPerSec: (snap.presentMs / secs),
    longtaskMsPerSec: snap.hooks.longtask ? snap.longtaskMs / secs : null,
    longtaskCount: snap.hooks.longtask ? snap.longtaskN : null,
    rafJitterP95Ms: p95(snap.rafIntervals),
  };
}

/** Everything both the engine and the host reported for one window. */
function windowMetrics(ctx, nodeStart, nodeEnd, snap, secs) {
  const eng = aggregateWindows(engineWindows(ctx.perfLines, nodeStart, nodeEnd));
  const notes = [];
  if (!eng.windows) notes.push('no BIBPERF windows closed inside the measured interval');
  return { metrics: { ...eng, ...hostMetrics(snap, secs) }, notes };
}

// --------------------------------------------------------------- scroll ---
export async function scrollRep(ctx, sc) {
  const page = ctx.page;
  const notes = [];
  const settled = await page.evaluate((t) => __bench.resetScroll(t), 10000);
  if (!settled) notes.push('scroll never settled at offset 0 before the window (inherited backlog risk)');

  await page.evaluate((a) => __bench.drive(a), { pxPerFrame: sc.pxPerFrame, ms: WARMUP_MS });
  const startOffset = await page.evaluate(() => __bench.offset());

  await page.evaluate(() => __bench.reset());
  const nodeStart = Date.now();
  const win = await page.evaluate((a) => __bench.drive(a), { pxPerFrame: sc.pxPerFrame, ms: ctx.secs * 1000 });
  const nodeEnd = Date.now();
  const during = await page.evaluate(() => __bench.snapshot());

  // Drain: the engine may still be working through queued input. Frames-quiet
  // costs nothing (no readback), unlike polling the offset.
  const drained = await page.evaluate(() => __bench.waitQuiet(400, 15000));
  const after = await page.evaluate(() => __bench.snapshot());
  const endOffset = await page.evaluate(() => __bench.offset());

  const secs = (win.end - win.start) / 1000;
  const { metrics, notes: n2 } = windowMetrics(ctx, nodeStart, nodeEnd, during, secs);
  notes.push(...n2);
  if (!drained) notes.push('engine never went quiet within 15 s after input stopped');

  // Bottomed out? A page that ran out of document stops scrolling and reads
  // as "fast". Ask for more scroll and see whether it moves — but an engine
  // that has stopped responding to input looks identical from here, and that
  // is a REGRESSION, not a harness problem. Scrolling back up separates them:
  // responsive-but-at-the-end moves up, wedged moves neither way.
  let invalid = null;
  if (endOffset != null) {
    const nudge = (dy) => page.evaluate(async (d) => {
      const B = __bench;
      const c = document.getElementById('screen').getBoundingClientRect();
      B.wheelAt(c.left + c.width / 2, c.top + c.height / 2, d);
      await B.waitQuiet(300, 5000);
      return B.offset();
    }, dy);
    const down = await nudge(1500);
    if (down != null && down <= endOffset) {
      const up = await nudge(-1500);
      if (up != null && up < down) invalid = 'page bottomed out (fixture too short for this rate)';
      else notes.push('the engine stopped responding to wheel input by the end of the run — kept as a VALID rep, this is the regression the suite exists to catch');
    }
  } else {
    notes.push('no scroll ruler decoded (non-fixture target?) — efficiency unavailable');
  }

  // Correctness oracle: back to the top, then fingerprint the frame. Taken at
  // offset 0 it is deterministic across reps, runs and machines, so "it got
  // faster because it stopped painting correctly" shows up as a changed hash.
  await page.evaluate((t) => __bench.resetScroll(t), 10000);
  await page.evaluate(() => __bench.waitQuiet(300, 8000));
  const checksum = await page.evaluate(() => __bench.checksum());
  const dispatchedPx = during.dispatchedPx;
  const efficiency = endOffset == null || !dispatchedPx ? null : (endOffset - startOffset) / dispatchedPx;
  if (efficiency != null && efficiency < 0.98)
    notes.push(`scroll efficiency ${efficiency.toFixed(3)}: the engine dropped scroll distance`);

  return {
    metrics: {
      ...metrics,
      efficiency,
      tailMs: after.lastFrameTs != null && win.end != null ? Math.max(0, after.lastFrameTs - win.end) : null,
      tailFrames: after.frames - during.frames,
    },
    extra: {
      startOffset, endOffset, dispatchedPx,
      dispatchedEvents: during.dispatched,
      wheelCallsReachingEngine: during.hooks.wheel ? during.wheelCalls : null,
      checksum, secs,
    },
    stableChecksum: checksum?.hash ?? null,
    notes,
    invalid,
  };
}

// --------------------------------------------------------------- update ---
export async function updateRep(ctx) {
  const page = ctx.page;
  await page.evaluate((ms) => __bench.idle(ms), WARMUP_MS);
  const c0 = await page.evaluate(() => __bench.counter());

  await page.evaluate(() => __bench.reset());
  const nodeStart = Date.now();
  const win = await page.evaluate((ms) => __bench.idle(ms), ctx.secs * 1000);
  const nodeEnd = Date.now();
  const snap = await page.evaluate(() => __bench.snapshot());
  const c1 = await page.evaluate(() => __bench.counter());

  const secs = (win.end - win.start) / 1000;
  const { metrics, notes } = windowMetrics(ctx, nodeStart, nodeEnd, snap, secs);
  const updates = c0 == null || c1 == null ? null : (c1 - c0 + 65536) % 65536;
  const checksum = await page.evaluate(() => __bench.checksum());
  return {
    metrics: { ...metrics, updatesPerSec: updates == null ? null : updates / secs },
    extra: { counterStart: c0, counterEnd: c1, checksum, secs },
    notes,
    invalid: updates === 0 ? 'the app never completed an update (pixel counter never advanced)' : null,
  };
}

// ---------------------------------------------------------------- input ---
export async function inputRep(ctx, sc) {
  const page = ctx.page;
  await page.evaluate(() => __bench.waitQuiet(300, 5000));

  await page.evaluate(() => __bench.reset());
  const nodeStart = Date.now();
  const r = await page.evaluate(async ({ clicks, keys, gapMs }) => {
    const B = __bench;
    // Every wanted colour is matched EXACTLY: the click zone's colours differ
    // by 1 between consecutive clicks, and a burst's intermediate checksums
    // can land a couple of units from the final one — any tolerance turns the
    // pixel already on screen into a false hit at ~0 ms.
    const t0 = performance.now();
    B.clicks ??= 0;
    B.sum ??= 0;
    const out = { clickMs: [], keyMs: [], burstMs: null, failed: null };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    for (let i = 0; i < clicks; i++) {
      const want = [(B.clicks + 1) & 255, 255, 0];
      const hit = await B.awaitPixel(100, 100, { want, tol: 0, timeoutMs: 10000 },
        () => B.clickAt(100, 100));
      if (!hit) { out.failed = 'click response never painted'; break; }
      B.clicks++;
      out.clickMs.push(hit.ms);
      await sleep(gapMs);
    }

    // Clicking the click zone took focus off the text field — take it back
    // before typing (the fixture's field is at 0,220 - 190,254).
    if (!out.failed) {
      B.clickAt(95, 237);
      await sleep(300);
    }

    // One key at a time: latency. The checksum zone is rgb(c,c,c) with
    // c = sum(charCodes) % 256, so the expected colour is known in advance.
    if (!out.failed) {
      for (let i = 0; i < keys && !out.failed; i++) {
        const ch = String.fromCharCode(97 + (i % 26));
        const c = (B.sum + ch.charCodeAt(0)) % 256;
        const hit = await B.awaitPixel(100, 350, { want: [c, c, c], tol: 0, timeoutMs: 10000 },
          () => B.typeChar(ch));
        if (!hit) { out.failed = 'key response never painted'; break; }
        B.sum = c;
        out.keyMs.push(hit.ms);
        await sleep(gapMs);
      }
    }

    // Burst: every key dispatched back to back, timed to the LAST checksum.
    if (!out.failed) {
      const burst = [];
      let c = B.sum;
      for (let i = 0; i < keys; i++) {
        const ch = String.fromCharCode(97 + ((i + 7) % 26));
        burst.push(ch);
        c = (c + ch.charCodeAt(0)) % 256;
      }
      const hit = await B.awaitPixel(100, 350, { want: [c, c, c], tol: 0, timeoutMs: 20000 },
        () => { for (const ch of burst) B.typeChar(ch); });
      if (!hit) out.failed = 'burst checksum never painted';
      else { B.sum = c; out.burstMs = hit.ms; }
    }
    out.elapsed = performance.now() - t0;
    return out;
  }, { clicks: sc.clicks ?? 8, keys: sc.keys ?? 10, gapMs: sc.gapMs ?? 250 });
  const nodeEnd = Date.now();
  const snap = await page.evaluate(() => __bench.snapshot());
  const secs = r.elapsed / 1000;
  const { metrics, notes } = windowMetrics(ctx, nodeStart, nodeEnd, snap, secs);
  const checksum = await page.evaluate(() => __bench.checksum());
  return {
    metrics: {
      ...metrics,
      clickLatencyMs: median(r.clickMs),
      typeLatencyMs: median(r.keyMs),
      typeBurstMs: r.burstMs,
    },
    extra: { clickMs: r.clickMs, keyMs: r.keyMs, burstMs: r.burstMs, checksum, secs },
    notes,
    invalid: r.failed,
  };
}

// ----------------------------------------------------------------- boot ---
export async function bootRep(ctx, sc) {
  const page = await ctx.newPage(sc);
  const notes = [];
  try {
    await page.addInitScript(bootProbe, sc.verify ?? null);
    await page.goto(ctx.viewerURL(sc.target), { timeout: ctx.bootTimeout });
    await page.waitForFunction(
      () => {
        if (globalThis.__bs?.ready && window.__benchReadyMs == null) window.__benchReadyMs = performance.now();
        return window.__benchReadyMs != null;
      }, null, { timeout: ctx.bootTimeout, polling: 'raf' },
    );
    await page.waitForFunction(
      () => {
        if (globalThis.__bs?.state?.progress >= 1 && window.__benchProgressMs == null)
          window.__benchProgressMs = performance.now();
        return window.__benchProgressMs != null;
      }, null, { timeout: ctx.bootTimeout, polling: 'raf' },
    );
    if (sc.verify) {
      try {
        await page.waitForFunction(() => window.__benchWatchMs != null, null,
          { timeout: 30000, polling: 'raf' });
      } catch { notes.push('verification pixel never appeared — page did not paint as expected'); }
    }
    // The loaded page at rest is a deterministic fingerprint — but the boot
    // page has no instrumentation yet (it is created per rep), so install it
    // here rather than reading a checksum that is always null.
    const checksum = await page.evaluate(installBench)
      .then(() => page.evaluate(() => globalThis.__bench?.checksum() ?? null))
      .catch(() => null);
    const m = await page.evaluate(() => ({
      bootMs: globalThis.__bs?.metrics?.bootMs ?? null,
      readyMs: window.__benchReadyMs ?? null,
      interactiveMs: window.__benchProgressMs ?? null,
      firstFrameMs: window.__benchFirstFrameMs ?? null,
      contentMs: window.__benchWatchMs ?? null,
      frames: globalThis.__bs?.frames ?? null,
    }));
    return {
      metrics: {
        bootMs: m.bootMs ?? m.readyMs,
        interactiveMs: m.interactiveMs,
        firstFrameMs: m.firstFrameMs,
        contentMs: m.contentMs,
      },
      extra: { ...m, checksum },
      stableChecksum: checksum?.hash ?? null,
      notes,
      invalid: sc.verify && m.contentMs == null ? 'target page never painted its verification pixel' : null,
    };
  } finally {
    await page.close();
  }
}

export const KINDS = { scroll: scrollRep, update: updateRep, input: inputRep, boot: bootRep };
