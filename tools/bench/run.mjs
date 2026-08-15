#!/usr/bin/env node
// Engine performance benchmark runner (report-only lab instrument).
//
//   node tools/bench/run.mjs [--ext <dir>] [--save <name>] [--compare <name>]
//        [--only a,b] [--diagnostic] [--size WxH] [--secs N] [--reps N]
//        [--viewer-params 'rcap=5'] [--url <URL>] [--headed]
//   node tools/bench/run.mjs --list
//   node tools/bench/run.mjs --diff <before> <after>
//
// Results are per-machine and never committed; they land in the MAIN
// checkout's bench/ so every worktree shares one pool.
//
// The suite is decoupled from the code under test: --ext points at ANY
// unpacked extension directory with a staged engine (an old worktree, say),
// while fixtures, harness and parsing always come from THIS checkout. See
// notes/perf-measurement.md § Bench suite for the contract and the retro-run
// recipe. Nothing here is a pass/fail gate.

import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { launch, extensionIdFromManifest, requireStagedEngine } from '../../test/harness/launch.mjs';
import { BENCH_HTTPS_PORT } from '../../test/harness/ports.mjs';
import { startBenchServer, BENCH_ORIGIN, benchResolverRule, FIXTURE_DIR } from './lib/server.mjs';
import { installBench } from './lib/page.mjs';
import { KINDS } from './lib/kinds.mjs';
import { collectProvenance, provenanceLines } from './lib/provenance.mjs';
import { saveRun, loadRun, listRuns, hashFile, BENCH_DIR } from './lib/store.mjs';
import { formatRun, formatCompare, METRICS, median, spread } from './lib/report.mjs';
import { SCENARIOS, selectScenarios, DEFAULT_SIZE } from './scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

if (has('help') || has('h')) {
  console.log(`bench runner — scenarios: ${SCENARIOS.map((s) => s.id).join(', ')}
results dir: ${BENCH_DIR}

  --ext <dir>          extension under test (default: this checkout's src/)
  --save <name>        write bench/<name>.json (unnamed runs go to bench/last.json)
  --compare <name>     print <name> -> this run as a delta table
  --diff <a> <b>       compare two saved runs, run nothing
  --list               list saved runs
  --only a,b           run just these scenario ids
  --diagnostic         also run the diagnostic tier
  --size WxH           viewport for scenarios without an explicit size (default 1600x900)
  --secs N             measured window per rep (default 4)
  --reps N             reps per scenario (default 3)
  --viewer-params 's'  extra viewer query params, e.g. 'rcap=5'
  --url <URL>          ad-hoc scroll run against an arbitrary URL (NOT part of the suite)
  --px-per-frame N     wheel rate for --url runs (px per HOST frame, x~60 for px/s)
  --headed             show the browser`);
  process.exit(0);
}

if (has('list')) {
  const runs = listRuns();
  if (!runs.length) console.log(`no saved runs in ${BENCH_DIR}`);
  for (const r of runs)
    console.log(`${r.name.padEnd(24)} ${r.savedAt ?? r.mtime.toISOString()}  engine=${r.engine ?? '?'}` +
      `  target=${r.target ?? '?'}  scenarios=${r.scenarios}`);
  process.exit(0);
}

if (has('diff')) {
  const i = argv.indexOf('--diff');
  const [a, b] = [argv[i + 1], argv[i + 2]];
  if (!a || !b) throw new Error('usage: --diff <before> <after>');
  console.log(formatCompare(loadRun(a), loadRun(b), { beforeName: a, afterName: b }));
  process.exit(0);
}

const EXT = resolve(arg('ext', join(HERE, '../../src')));
const SECS = Number(arg('secs', '4'));
const REPS = Number(arg('reps', '3'));
const SIZE = arg('size', DEFAULT_SIZE.join('x')).split('x').map(Number);
const VIEWER_PARAMS = arg('viewer-params', '').replace(/^&|&$/g, '');
const ADHOC_URL = arg('url', null);
const BOOT_TIMEOUT = 180000;

if (!existsSync(join(EXT, 'manifest.json')))
  throw new Error(`--ext ${EXT} is not an unpacked extension (no manifest.json)`);
requireStagedEngine(EXT); // prints engine identity; warns if a build is running

let scenarios;
try {
  scenarios = ADHOC_URL
  ? [{
      id: 'adhoc', tier: 'adhoc', kind: 'scroll', pxPerFrame: Number(arg('px-per-frame', '60')),
      target: ADHOC_URL, what: `ad-hoc target ${ADHOC_URL}`,
    }]
    : selectScenarios({ only: arg('only', '')?.split(',').filter(Boolean), diagnostic: has('diagnostic') });
} catch (e) {
  console.error(`${e.message}\nknown ids: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  process.exit(2);
}

const server = await startBenchServer();
const newSession = () => launch({
  extensionDir: EXT,
  headless: !has('headed'),
  needsEngine: true,
  extraResolverRules: benchResolverRule(BENCH_HTTPS_PORT),
});
const session = await newSession();
const EXT_ID = extensionIdFromManifest(EXT);
const provenance = collectProvenance(EXT);
const warnings = [];
if (provenance.engineBuildRunning)
  warnings.push(`ENGINE BUILD RUNNING [${provenance.engineBuildRunning}] — every timing number in this run is suspect`);
if (ADHOC_URL)
  warnings.push(`ad-hoc --url run: ${ADHOC_URL} is NOT part of the suite and is not reproducible`);

console.log(provenanceLines(provenance).join('\n'));
console.log(`fixtures: ${FIXTURE_DIR} -> ${BENCH_ORIGIN}`);
for (const w of warnings) console.log(`! ${w}`);

const viewerURL = (target) =>
  `chrome-extension://${EXT_ID}/ext/viewer.html?perflog=1&persist=0` +
  (VIEWER_PARAMS ? `&${VIEWER_PARAMS}` : '') + `&url=${target}`; // RAW target, never encoded

const targetOf = (sc) => sc.target ?? `${BENCH_ORIGIN}/${sc.fixture}`;

function fixtureHashes(sc) {
  const out = {};
  for (const f of [sc.fixture, ...(sc.extraFixtures ?? [])].filter(Boolean))
    out[f] = hashFile(join(FIXTURE_DIR, f));
  return out;
}

/** A page with the scenario's viewport, a BIBPERF console tap and an error tap. */
async function newPage(sc, perfLines, ses = session, errors = []) {
  const page = await ses.context.newPage();
  const [w, h] = sc.size ?? SIZE;
  await page.setViewportSize({ width: w, height: h });
  page.on('console', (m) => {
    const text = m.text();
    if (text.includes('BIBPERF')) perfLines.push({ text, at: Date.now() });
  });
  // A viewer that throws is exactly what an old --ext target does when the
  // contract moved; it must reach the report, not vanish.
  page.on('pageerror', (e) => errors.push(e.message));
  return page;
}

/** Wait for the scenario's verification pixel, so no rep measures a blank page. */
async function waitForPixel(page, verify, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate((v) => globalThis.__bs?.probe(v.x, v.y), verify);
    if (last && last.every((c, i) => Math.abs(c - verify.rgb[i]) <= (verify.tol ?? 6))) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`verification pixel @${verify.x},${verify.y} = [${last}], want [${verify.rgb}]`);
}

async function runScenario(sc, ses = session) {
  const perfLines = [];
  const target = targetOf(sc);
  const [w, h] = sc.size ?? SIZE;
  const result = {
    kind: sc.kind,
    what: sc.what,
    target,
    viewport: `${w}x${h}`,
    fixtureHashes: sc.fixture ? fixtureHashes(sc) : {},
    reps: [],
    invalid: [],
    notes: [],
  };
  const pageErrors = [];
  const ctx = {
    secs: SECS, perfLines, viewerURL, bootTimeout: BOOT_TIMEOUT,
    newPage: (s) => newPage(s, perfLines, ses, pageErrors),
  };

  if (sc.kind === 'boot') {
    // One throwaway boot first: the first navigation in a fresh profile pays
    // for the extension's cold caches, and it lands 40% above the warm boots
    // it is averaged with. Boot numbers here are WARM-boot numbers.
    await KINDS.boot({ ...ctx }, { ...sc, target });
    for (let i = 0; i < REPS; i++) {
      perfLines.length = 0;
      const rep = await KINDS.boot({ ...ctx }, { ...sc, target });
      (rep.invalid ? result.invalid : result.reps).push(rep);
      process.stdout.write(rep.invalid ? '!' : '.');
    }
  } else {
    const page = await newPage(sc, perfLines, ses, pageErrors);
    try {
      await page.goto(viewerURL(target), { timeout: BOOT_TIMEOUT });
      await page.waitForFunction(
        () => globalThis.__bs?.ready && globalThis.__bs.state.progress >= 1,
        null, { timeout: BOOT_TIMEOUT },
      );
      if (sc.verify) await waitForPixel(page, sc.verify, 120000);
      const installed = await page.evaluate(installBench);
      const hooks = await page.evaluate(() => __bench.hooks);
      if (installed === 'already') result.notes.push('instrumentation was already installed');
      for (const [k, v] of Object.entries(hooks))
        if (!v) result.notes.push(`host hook unavailable on this target: ${k}`);
      // Let the page settle after load before the first rep.
      await page.evaluate(() => __bench.waitQuiet(500, 20000));
      ctx.page = page;
      for (let i = 0; i < REPS; i++) {
        if (await page.evaluate(() => !!globalThis.__bs?.dead))
          throw new Error('engine died mid-scenario');
        const rep = await KINDS[sc.kind](ctx, sc);
        (rep.invalid ? result.invalid : result.reps).push(rep);
        process.stdout.write(rep.invalid ? '!' : '.');
      }
    } finally {
      await page.close();
    }
  }

  // Medians + rep spread over the valid reps only.
  result.median = {};
  result.spread = {};
  for (const m of METRICS) {
    const vals = result.reps.map((r) => r.metrics?.[m.key]).filter((v) => Number.isFinite(v));
    if (!vals.length) continue;
    result.median[m.key] = median(vals);
    result.spread[m.key] = spread(vals);
  }
  for (const rep of [...result.reps, ...result.invalid])
    for (const n of rep.notes ?? []) if (!result.notes.includes(n)) result.notes.push(n);
  for (const rep of result.invalid) result.notes.push(`INVALID rep: ${rep.invalid}`);
  // Deterministic end-state fingerprints (scroll: at offset 0; boot: the
  // loaded page at rest). Same pixels => same hash, on any machine.
  const sums = [...new Set(result.reps.map((r) => r.stableChecksum).filter((v) => v != null))];
  if (sums.length) result.checksums = sums;
  if (sums.length > 1)
    result.notes.push(`end-state checksum differs between reps (${sums.join(', ')}) — this scenario did not render deterministically`);
  // One raw line, kept verbatim: which fields this target's engine actually
  // reported is the first question when an old record looks thin.
  result.sampleBibperf = perfLines.filter((l) => l.text.includes('BIBPERF')).pop()?.text ?? null;
  for (const e of [...new Set(pageErrors)].slice(0, 5)) result.notes.push(`viewer threw: ${e}`);
  if (!result.reps.length) result.notes.push('NO VALID REPS — this scenario reported nothing');
  return result;
}

const record = {
  savedAt: new Date().toISOString(),
  config: {
    ext: EXT, secs: SECS, reps: REPS, viewport: SIZE.join('x'),
    viewerParams: VIEWER_PARAMS, headless: !has('headed'),
    scenarios: scenarios.map((s) => s.id),
  },
  provenance,
  warnings,
  scenarios: {},
};

for (const sc of scenarios) {
  process.stdout.write(`\n${sc.id.padEnd(22)} `);
  try {
    // Startup is measured in a browser that has not just hosted six engine
    // instances: after a full headline pass the same boot costs 2-3x more, and
    // that is the harness's memory pressure, not the engine's startup.
    if (sc.kind === 'boot') {
      const ses = await newSession();
      try { record.scenarios[sc.id] = await runScenario(sc, ses); }
      finally { await ses.close(); }
    } else record.scenarios[sc.id] = await runScenario(sc);
  } catch (e) {
    record.scenarios[sc.id] = { kind: sc.kind, target: targetOf(sc), reps: [], invalid: [],
      median: {}, spread: {}, notes: [`SCENARIO FAILED: ${e.message}`] };
    process.stdout.write(` FAILED: ${e.message}`);
  }
}
process.stdout.write('\n');

// Ratios against text-scroll from the SAME run: they transfer across machines
// far better than absolute numbers do.
for (const sc of scenarios) {
  const base = record.scenarios[sc.ratioBase ?? 'text-scroll'];
  const self = record.scenarios[sc.id];
  if (!base || !self || base === self) continue;
  self.ratios = {};
  for (const key of ['fps', 'busyPct', 'paintMsPerSec', 'avgPaintedFrameMs', 'hostPresentMsPerSec'])
    if (Number.isFinite(base.median?.[key]) && Number.isFinite(self.median?.[key]) && base.median[key])
      self.ratios[key] = self.median[key] / base.median[key];
}

await session.close();
await server.close();

console.log(formatRun(record));
const savePath = saveRun(arg('save', 'last'), record);
console.log(`\nsaved: ${savePath}`);
for (const w of warnings) console.log(`! ${w}`);

const compareTo = arg('compare', null);
if (compareTo) {
  console.log('');
  console.log(formatCompare(loadRun(compareTo), record, { beforeName: compareTo, afterName: arg('save', 'last') }));
}
