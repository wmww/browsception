# Wheel can't scroll the page when the root has `overscroll-behavior` ≠ auto

**Status: implemented on branch `overscroll-wheel-scroll` (commit `d00ac45`, not pushed, not
merged).** This file is now a decision document: what the original plan got right, what it got
wrong, what the branch contains, and the one shape question worth a second opinion before merge.

## Symptom (unchanged)

tumblr.com logged out: 5953 px of document in an 861 px viewport, `scrollY` stays 0 however much
you wheel, while the overflow-scroll carousel at the top scrolls fine and so do `scrollTo()` and
Space. Tumblr sets `overscroll-behavior: contain` on `html` and `body`; only `html`'s value
matters. Same on `scroll.bstest` with `html` set to `contain` or `none`. Not tumblr-specific —
this is the standard way to turn off bounce and pull-to-refresh, so every such site was dead.

## What the original diagnosis got right, and what it missed

Right: the sync wheel path applies the **root's** `overscroll-behavior` to the step *into* the
viewport, which is not a propagation at all. Wrong: there is **one** such block, and upstream
314170@main fixes it. There are **two**, and the backport alone changes nothing — measured, not
argued (see § Evidence).

1. `EventHandler::handleWheelEventInternal` ran the frame view's propagation filter *before* the
   view scrolled itself, so the delta was zeroed (or the bail-out taken) first. This is
   upstream's bug, fixed in 314170@main (`25e43d9150`, webkit.org/b/281300); we backport it.
2. `EventHandler::handleWheelEventInAppropriateEnclosingBox` — the DOM default handler, which
   **does** run for us (`m_currentWheelEventAllowsScrolling` is true under SynchronousScrolling)
   — walks the containing-block chain and reaches the document element, whose box *always* has a
   `RenderLayerScrollableArea` (`RenderBox::requiresLayerWithScrollableArea`, upstream-marked
   "FIXME: This is wrong"). That area reports the root's `contain`, can never scroll, so the walk
   fell into `shouldBlockScrollPropagation` → `setDefaultHandled()` → `handleWheelEventInternal`
   returned true before ever reaching the code (1) fixes. Still unfixed upstream.

Each block bails before the other runs, so neither hunk alone moves a single pixel.

## Why *we* hit this and nobody else does

Not because we hold WebKit oddly — this configuration is one upstream supports:

- `WebPageProxy::handleWheelEvent` passes exactly `{ SynchronousScrolling }` whenever the drawing
  area has no scroll dispatcher, i.e. any port without async scrolling. `bibApplyWheel` asks for
  the same thing.
- `ENABLE_ASYNC_SCROLLING` is ON for Mac/GTK/WPE, **explicitly OFF for PlayStation**, off by
  default for Win. `ENABLE_WHEEL_EVENT_LATCHING` is Mac-only, and on Mac
  `defaultWheelEventHandler` returns early once the latched scroller is the frame view
  ("FrameView scrolling is handled via processWheelEventForScrolling()") — which is precisely
  what keeps Mac out of block (2).
- So WinCairo and PlayStation are in our configuration, and block (2) is live for them today on
  any such page. Worth reporting upstream; nobody has.

Alternatives to patching, considered and rejected:

- **Turn on async scrolling** (the "typical" holding): needs a scrolling tree, which needs
  `GraphicsLayer`/a compositor, which the port refuses by design (no GPU, CPU raster) — and the
  shipping link is `-no-pthread`, so there is no scrolling thread either.
- **Turn on `WHEEL_EVENT_LATCHING`**: would coincidentally skip the bad walk, but it is Mac
  gesture-phase machinery (`isGestureStart`, momentum) and our `PlatformWheelEvent`s are
  phaseless. A bigger hack wearing a config flag's clothes.
- **Wait for a rebase**: removes hunk (1) only. Hunk (2) survives any rebase until upstream fixes
  it.

## The open question for review: the shape of hunk (2)

The branch takes the narrowest option. Two others exist and were *not* built or measured:

- **(a) shipped** — in the walk, skip the propagation block when
  `currentEnclosingBox->isDocumentElementRenderer()`. Narrowest; touches only wheel chaining.
- **(b)** make `scrollableAreaForBox()` return nullptr for the document element. Also skips
  `scrollableAreaCanHandleEvent`/`handleWheelEventInScrollableArea` for it — both no-ops today
  (that area is never `isScrollableOrRubberbandable`), but it would change rubber-band behaviour
  if we ever grow any.
- **(c)** fix it at the source: have `RenderLayerScrollableArea::{horizontal,vertical}OverscrollBehavior`
  return `Auto` for the document element, since the root's value belongs to the frame view —
  which already reads that same style (`LocalFrameView::verticalOverscrollBehavior`). Arguably
  the most correct and the best upstream patch: it fixes every consumer, not just this walk.
  Risk: those values also feed `AsyncScrollingCoordinator`'s scrolling-node parameters (dead code
  for us, live for the ports that would take the patch), so it needs their review, not ours.

If the goal is "smallest local divergence", (a). If the goal is "a patch to send upstream", (c)
is probably the one to write. They are not exclusive — (a) can ship now and (c) can be the
upstream proposal.

## What is on the branch

`overscroll-wheel-scroll` @ `d00ac45`, 10 files:

- `engine/WebkitWasm/src/patches/webkit-emscripten.patch` — the two `EventHandler.cpp` hunks
  (+52 lines; patch is 80 files now).
- `test/fixtures/pages/scroll.html` — `?ob=<value>` sets the root's `overscroll-behavior`,
  `?inner=1` is a short 10-section variant, `?frame=1` embeds it as a 300×300 subframe at
  200..500 × 0..300 with root `contain`. The server ignores the query; the plain page is
  byte-identical in behaviour to before, so scenarios 18/20 and the perf probes are untouched.
- `test/tier2/scenarios.test.mjs` — scenario 26: `ob=contain` and `ob=none` scroll the summed
  300 px (guest `scrollY` **and** the section-border pixel probe), and a contained subframe takes
  its 900 px while the 600 px of leftover chains nowhere.
- Notes: mechanism in `engine-internals.md`; an **upstream-owned hunks** table in
  `engine-build.md` (drop the backport on a rebase past 314170@main); scenario 26 + the fixture
  knobs in `testing.md`; a sync-path line in `rendering-input.md`; entries in `README.md` and
  `experiment-log.md`.

## Evidence

- Scenario 26 written first and run against the shipped engine: 3/3 fail.
- Backport only, rebuilt: **3/3 still fail, unchanged.**
- Doc-element hunk only, backport reverted, rebuilt (snapshot `20260912-003944`): **3/3 fail.**
  (`overscroll-behavior: contain` sets both axes, so the pre-scroll
  `shouldBlockScrollPropagation` returns true unconditionally.)
- Both hunks: 3/3 pass. Tier-0 75, tier-1 36, tier-2 43/43 (Chrome + HiDPI + Firefox subset).
- Real site: tumblr.com wheels 5×200 → `scrollY` exactly 1000 (was 0).
- Feature-still-works probe (not a committed test): a pinned `overflow:auto;
  overscroll-behavior:contain` box chains nothing to the page; flipped to `auto` it chains all
  1000 px.

## State of this checkout

This branch (`wt_kQJCt9xvvOLx3gcM`) does **not** contain the fix; `src/engine/` here is staged
back to the matching unfixed artifact (`20260911-043137`). The shared `third_party/WebKit` tree
still holds the *fixed* patch — harmless, and the takeover is lossless either way, but a build
from here will spend ~1.5 min reloading the tree (and the branch's own build is a fast-path hit
on the old snapshot). To review the fix: check out `overscroll-wheel-scroll`, then
`bash scripts/build-engine.sh` (fast path: snapshot `20260911-233647` already matches) →
`node scripts/stage-engine.mjs` → `node --test --test-name-pattern='overscroll-behavior'
test/tier2/scenarios.test.mjs`.

## Out of scope, found alongside

Arrow keys, PageUp/Down and Home/End never scroll any page, while Space does. Unrelated to
overscroll-behavior, untouched by this branch. See `plans/keyboard-keys.md`.
