// The scenario matrix.
//
// Few scenarios, wide workload spread, composite over purified: one realistic
// page exercising four mechanisms at once is much harder to Goodhart than four
// synthetic pages each isolating one. Every scenario verifies its output from
// pixels, so "fast because it stopped painting correctly" reads as a failure.
//
// Fixtures are APPEND-ONLY: changing one invalidates every saved result that
// used it. A changed workload gets a NEW scenario id (the record stores each
// fixture's hash and --compare warns when they differ).

export const DEFAULT_SIZE = [1600, 900];
export const BIG_SIZE = [2560, 1330];

/** verify: framebuffer pixel that proves the page itself painted. */
export const SCENARIOS = [
  // ---------------------------------------------------------- headline ---
  {
    id: 'text-scroll',
    tier: 'headline',
    kind: 'scroll',
    fixture: 'text-scroll.html',
    pxPerFrame: 60,
    verify: { x: 4, y: 4, rgb: [0, 0, 128] },
    what: 'plain long text, wheel at 60 px/host-frame — the ratio denominator',
  },
  {
    id: 'article-scroll',
    tier: 'headline',
    kind: 'scroll',
    fixture: 'article.html',
    pxPerFrame: 60,
    verify: { x: 4, y: 4, rgb: [0, 0, 128] },
    what: 'composite article: sticky header + fixed TOC sidebar measuring every chapter per scroll tick + inline images + shadowed cards',
  },
  {
    id: 'text-scroll-2560',
    tier: 'headline',
    kind: 'scroll',
    fixture: 'text-scroll.html',
    size: BIG_SIZE,
    pxPerFrame: 60,
    verify: { x: 4, y: 4, rgb: [0, 0, 128] },
    ratioBase: 'text-scroll-2560',
    what: 'text-scroll at a large framebuffer (blit/paint area scaling)',
  },
  {
    id: 'article-scroll-2560',
    tier: 'headline',
    kind: 'scroll',
    fixture: 'article.html',
    size: BIG_SIZE,
    pxPerFrame: 60,
    verify: { x: 4, y: 4, rgb: [0, 0, 128] },
    ratioBase: 'text-scroll-2560',
    what: 'article-scroll at a large framebuffer',
  },
  {
    id: 'app-update',
    tier: 'headline',
    kind: 'update',
    fixture: 'app-update.html',
    extraFixtures: ['vendor/preact.min.js'],
    what: 'Preact app re-rendering a 240-row table every rAF (VDOM diff, GC pressure); the rcap-throttle workload class',
  },
  {
    id: 'input-latency',
    tier: 'headline',
    kind: 'input',
    fixture: 'input-latency.html',
    clicks: 8,
    keys: 10,
    gapMs: 250,
    verify: { x: 100, y: 100, rgb: [128, 128, 128] },
    what: 'click -> painted response, per-key latency, and a 10-key burst',
  },
  {
    id: 'boot-trivial',
    tier: 'headline',
    kind: 'boot',
    fixture: 'trivial.html',
    verify: { x: 20, y: 20, rgb: [0, 128, 255] },
    what: 'engine startup: navigation -> ready -> load complete -> the page on screen',
  },
  {
    id: 'boot-article',
    tier: 'headline',
    kind: 'boot',
    fixture: 'article.html',
    verify: { x: 4, y: 4, rgb: [0, 0, 128] },
    what: 'contentful boot: the same, on a page with real parse/style/layout work',
  },

  // -------------------------------------------------------- diagnostic ---
  // Not run by default and never headline numbers: these exist to localize
  // which subsystem moved when a composite scenario regresses.
  {
    id: 'paint-heavy-scroll',
    tier: 'diagnostic',
    kind: 'scroll',
    fixture: 'paint-heavy.html',
    pxPerFrame: 60,
    verify: { x: 4, y: 4, rgb: [0, 0, 128] },
    what: 'box-shadow/blur/gradient cards — Skia raster worst case',
  },
  {
    id: 'image-scroll',
    tier: 'diagnostic',
    kind: 'scroll',
    fixture: 'image-scroll.html',
    pxPerFrame: 60,
    verify: { x: 4, y: 4, rgb: [0, 0, 128] },
    what: 'image-dense page — decode/upload path in isolation',
  },
  {
    id: 'sticky-scroll',
    tier: 'diagnostic',
    kind: 'scroll',
    fixture: 'sticky-scroll.html',
    pxPerFrame: 60,
    verify: { x: 4, y: 4, rgb: [0, 0, 128] },
    what: 'sticky/fixed elements WITHOUT article-scroll\'s TOC handler',
  },
  {
    id: 'js-churn',
    tier: 'diagnostic',
    kind: 'update',
    fixture: 'js-churn.html',
    what: 'plain rAF + timer DOM mutation, no framework',
  },
];

export const byId = (id) => SCENARIOS.find((s) => s.id === id);

/** @param {{only?: string[], diagnostic?: boolean}} opts */
export function selectScenarios({ only, diagnostic } = {}) {
  if (only?.length) {
    const missing = only.filter((id) => !byId(id));
    if (missing.length) throw new Error(`unknown scenario(s): ${missing.join(', ')}`);
    return only.map(byId);
  }
  return SCENARIOS.filter((s) => diagnostic || s.tier === 'headline');
}
