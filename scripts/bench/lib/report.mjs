// Metric registry + terminal tables (run summary, before -> after comparison).
//
// Report-only by design: nothing here fails a build. A delta is called out
// only when it clears BOTH a fixed floor and the rep spread observed in the
// two runs being compared — 3 reps is a weak spread estimate, so the floors
// carry most of the weight (plans/perf-benchmarks.md § Runner).

/** better: which direction is an improvement. floorRel/floorAbs: noise floors. */
export const METRICS = [
  { key: 'fps', label: 'presented fps', better: 'higher', floorRel: 0.10, digits: 1 },
  // Frames counted at the host's bibFrame hook: cross-checks BIBPERF fps, and
  // is the only fps a target too old for ?perflog=1 can report.
  { key: 'hostFps', label: 'host frames/s', better: 'higher', floorRel: 0.10, digits: 1 },
  { key: 'busyPct', label: 'engine busy%', better: 'lower', floorAbs: 5, digits: 0 },
  { key: 'hostPresentMsPerSec', label: 'host present ms/s', better: 'lower', floorRel: 0.15, floorAbs: 4, digits: 0 },
  { key: 'longtaskMsPerSec', label: 'host longtask ms/s', better: 'lower', floorRel: 0.25, floorAbs: 20, digits: 0 },
  { key: 'rafJitterP95Ms', label: 'host rAF p95 ms', better: 'lower', floorRel: 0.25, floorAbs: 2, digits: 1 },
  { key: 'paintMsPerSec', label: 'paint ms/s', better: 'lower', floorRel: 0.15, floorAbs: 5, digits: 0 },
  { key: 'layoutMsPerSec', label: 'layout ms/s', better: 'lower', floorRel: 0.20, floorAbs: 5, digits: 0 },
  { key: 'avgPaintedFrameMs', label: 'avg painted frame ms', better: 'lower', floorRel: 0.15, floorAbs: 0.3, digits: 1 },
  { key: 'paintMpxPerFrame', label: 'Mpx/frame', better: 'lower', floorRel: 0.15, floorAbs: 0.02, digits: 2 },
  { key: 'updatesPerSec', label: 'updates/s', better: 'higher', floorRel: 0.10, floorAbs: 1, digits: 1 },
  { key: 'clickLatencyMs', label: 'click latency ms', better: 'lower', floorRel: 0.15, floorAbs: 2, digits: 1 },
  { key: 'typeLatencyMs', label: 'key latency ms', better: 'lower', floorRel: 0.15, floorAbs: 2, digits: 1 },
  { key: 'typeBurstMs', label: 'type burst ms', better: 'lower', floorRel: 0.15, floorAbs: 4, digits: 0 },
  { key: 'bootMs', label: 'engine ready ms', better: 'lower', floorRel: 0.15, floorAbs: 25, digits: 0 },
  { key: 'interactiveMs', label: 'load complete ms', better: 'lower', floorRel: 0.15, floorAbs: 25, digits: 0 },
  { key: 'firstFrameMs', label: 'first frame ms', better: 'lower', floorRel: 0.15, floorAbs: 25, digits: 0 },
  { key: 'contentMs', label: 'page pixels ms', better: 'lower', floorRel: 0.15, floorAbs: 25, digits: 0 },
  // The scroll ruler decodes at 120 px, so efficiency carries ~1% quantization.
  { key: 'efficiency', label: 'scroll efficiency', better: 'higher', floorRel: 0.03, floorAbs: 0.02, digits: 3 },
  { key: 'tailMs', label: 'post-input tail ms', better: 'lower', floorRel: 0.30, floorAbs: 60, digits: 0 },
  { key: 'wheelQueueMax', label: 'wheel queue max', better: 'lower', floorAbs: 3, digits: 0 },
  { key: 'wheelMergedRatio', label: 'wheel merge ratio', better: null, floorRel: 0.30, floorAbs: 0.1, digits: 2 },
  { key: 'blitFallbacks', label: 'blit fallbacks', better: 'lower', floorAbs: 3, digits: 0 },
  { key: 'heapGrowthMB', label: 'heap growth MB', better: 'lower', floorAbs: 24, digits: 0 },
  { key: 'jscGrowthMB', label: 'jsc growth MB', better: 'lower', floorAbs: 8, digits: 0 },
];
const BY_KEY = new Map(METRICS.map((m) => [m.key, m]));

export const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = v.length >> 1;
  return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
};
export const p95 = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] : null;
};

/** Relative spread of a metric across reps: (max - min) / |median|. */
export function spread(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return null;
  const m = median(v);
  if (!m) return null;
  return (Math.max(...v) - Math.min(...v)) / Math.abs(m);
}

const fmt = (v, digits) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits));
const pad = (s, n, right = true) => (right ? String(s).padStart(n) : String(s).padEnd(n));

export function metricsOf(scenario) {
  return METRICS.filter((m) => scenario.median?.[m.key] != null);
}

/** Per-scenario table for a single run. */
export function formatRun(record) {
  const out = [];
  for (const [id, sc] of Object.entries(record.scenarios)) {
    const head = `${id}  [${sc.viewport}, ${sc.reps.length} reps` +
      (sc.invalid?.length ? `, ${sc.invalid.length} INVALID` : '') + ']';
    out.push('', head, '-'.repeat(head.length));
    for (const m of metricsOf(sc)) {
      const s = sc.spread?.[m.key];
      const ratio = sc.ratios?.[m.key];
      out.push(`  ${pad(m.label, 22, false)} ${pad(fmt(sc.median[m.key], m.digits), 10)}` +
        `  ±${pad(s == null ? '—' : (s * 100).toFixed(0) + '%', 5, false)}` +
        (ratio != null ? `  ${pad(ratio.toFixed(2) + '× text-scroll', 18, false)}` : ''));
    }
    if (sc.checksums?.length) out.push(`  ${pad('end-state checksum', 22, false)} ${pad(sc.checksums.join(','), 10)}`);
    for (const note of sc.notes ?? []) out.push(`  ! ${note}`);
  }
  return out.join('\n');
}

/**
 * before -> after delta table. A metric is flagged when the change clears
 * max(floor, spread of either run); everything else prints as "~".
 */
export function formatCompare(before, after, { beforeName = 'before', afterName = 'after' } = {}) {
  const out = [];
  const warn = [];
  const bp = before.provenance ?? {}, ap = after.provenance ?? {};
  out.push(`compare: ${beforeName} -> ${afterName}`);
  out.push(`  engine: ${bp.engine?.stamp ?? '?'} -> ${ap.engine?.stamp ?? '?'}`);
  out.push(`  target: ${bp.target?.rev ?? '?'} -> ${ap.target?.rev ?? '?'}`);
  if (bp.machine?.hostname !== ap.machine?.hostname)
    warn.push(`different machines (${bp.machine?.hostname} vs ${ap.machine?.hostname}) — absolute numbers are not comparable, read the ratios`);
  // Threshold kept loose on purpose: back-to-back runs always read an
  // elevated load1 on the second one (it still carries the first run's tail).
  const bl = bp.machine?.load1, al = ap.machine?.load1;
  if (bl != null && al != null && Math.abs(al - bl) > Math.max(4, Math.min(al, bl)))
    warn.push(`machine load differed at run start (${bl} vs ${al}) — a delta of any size here can be the machine, not the change`);
  if (before.config?.secs !== after.config?.secs)
    warn.push(`different window lengths (${before.config?.secs}s vs ${after.config?.secs}s)`);
  if (before.config?.viewerParams !== after.config?.viewerParams)
    warn.push(`different viewer params ("${before.config?.viewerParams ?? ''}" vs "${after.config?.viewerParams ?? ''}")`);
  if ((before.config?.chromiumArgs ?? '') !== (after.config?.chromiumArgs ?? ''))
    warn.push(`different chromium args ("${before.config?.chromiumArgs ?? ''}" vs "${after.config?.chromiumArgs ?? ''}")`);

  const ids = [...new Set([...Object.keys(before.scenarios), ...Object.keys(after.scenarios)])];
  for (const id of ids) {
    const b = before.scenarios[id], a = after.scenarios[id];
    if (!b || !a) {
      out.push('', `${id}: only in ${b ? beforeName : afterName} — skipped`);
      continue;
    }
    const fixWarn = [];
    for (const [f, h] of Object.entries(a.fixtureHashes ?? {}))
      if (b.fixtureHashes?.[f] && b.fixtureHashes[f] !== h)
        fixWarn.push(`fixture ${f} CHANGED between runs (${b.fixtureHashes[f]} -> ${h}) — not the same workload`);
    if (a.viewport !== b.viewport) fixWarn.push(`viewport ${b.viewport} -> ${a.viewport}`);
    if (b.checksums?.length && a.checksums?.length && b.checksums.join(',') !== a.checksums.join(','))
      fixWarn.push(`end-state checksum ${b.checksums.join(',')} -> ${a.checksums.join(',')}` +
        ' — the two runs did not put the same pixels on screen');
    out.push('', `${id}`, '-'.repeat(id.length));
    for (const w of fixWarn) out.push(`  ! ${w}`);
    const keys = METRICS.filter((m) => b.median?.[m.key] != null || a.median?.[m.key] != null);
    for (const m of keys) {
      const bv = b.median?.[m.key], av = a.median?.[m.key];
      let delta = '—', flag = '';
      if (bv != null && av != null) {
        // The noise band is compared in ABSOLUTE terms so that a metric
        // sitting at zero (no longtasks, no blit fallbacks) is handled like
        // any other instead of dividing by it.
        const abs = av - bv;
        const rel = bv === 0 ? null : abs / Math.abs(bv);
        const noise = Math.max(
          m.floorAbs ?? 0,
          Math.abs(bv) * Math.max(m.floorRel ?? 0, b.spread?.[m.key] ?? 0, a.spread?.[m.key] ?? 0),
        );
        delta = rel == null ? abs.toFixed(m.digits)
          : `${rel >= 0 ? '+' : ''}${(rel * 100).toFixed(1)}%`;
        if (Math.abs(abs) <= noise) flag = '~';
        else if (m.better) flag = (av > bv) === (m.better === 'higher') ? 'BETTER' : 'WORSE';
        else flag = 'moved';
      }
      out.push(`  ${pad(m.label, 22, false)} ${pad(fmt(bv, m.digits), 10)} -> ${pad(fmt(av, m.digits), 10)}` +
        `  ${pad(delta, 8)}  ${flag}`);
    }
  }
  if (warn.length) out.push('', ...warn.map((w) => `! ${w}`));
  return out.join('\n');
}

export const metricMeta = (key) => BY_KEY.get(key);
