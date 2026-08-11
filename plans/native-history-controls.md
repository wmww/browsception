# Native back/forward/reload via tab-history mirroring

Make the top-level browser's own back/forward/reload controls drive the nested engine, and
remove the custom `#back`/`#fwd`/`#reloadbtn` buttons from the viewer chrome. The foundation —
syncing the tab URL to the engine's committed URL — is also the exact fix for the (deleted)
issue `popup-escape-hatch-uses-stale-url.md`, absorbed into step 1 below.

## Why one piece of work

The viewer receives true engine URLs via `bibChrome('url')` signals (`src/ext/viewer.mjs`
`bibChrome`, with `canGoBack`/`canGoForward`) but only paints them into the fake URL bar — the
tab URL stays frozen at the original `viewer.html?url=<entry-point>`. Everything that reads
`tab.url` (popup, SW sweep, badge) sees the entry point, not the current page. And native
controls do the wrong thing: back leaves the viewer entirely (one history entry), reload
reboots at the stale entry-point URL.

## Step 1 — tab-URL sync (small, independently shippable; fixes the escape-hatch bug)

On each `url` signal with an http(s) URL, `history.replaceState` (later push, step 2) the tab
to `viewer.html?<prefix-params>url=<current>`.

- Write the URL **raw**, not percent-encoded: popup (`popup.mjs` `viewerTarget`) and sweep
  (`sw.mjs` `viewerTarget`) slice at the first `url=` without decoding, matching the DNR `\0`
  contract. Encoding would break `new URL(target)` in the popup.
- Preserve the viewer's own params (`blit`, `persist`, …), which must precede `url=`.
- Skip boot/about (non-http) URLs; dedupe — each nav emits the signal twice (commit +
  `didFinishLoad`, see `BibPageClients.h` `dispatchDidFinishLoad` comment).

### Bug this fixes (former issue text)

The popup derives the current tab's URL by parsing `?url=` out of the tab's address. Since the
viewer never syncs it, "Open natively once" escapes to the URL the tab was *originally*
redirected to. Repro: sandboxed tab on `https://a.example/`, click a nested link to
`https://a.example/deep` (or another domain), popup → "Open natively once" → tab goes native
on `https://a.example/`. Consequences beyond the wrong destination:

- The escape session rule is keyed on the *stale* host (`normalizeEntry` of that URL), so
  escaping from a page on a different domain installs an allow rule for the wrong domain.
- The popup's disposition/host row and per-site action labels ("Trust <domain>") come from the
  same stale URL — a whitelist add can name the wrong domain.
- The SW sweep and badge evaluate the entry point rather than the page actually loaded.

The in-viewer "native" button (which used the live engine URL and didn't have this bug) was
already removed; the popup is the only escape hatch, so this is the only path.

## Step 2 — native back/forward (the meat)

Mirror the engine's history into the tab's session history: **pushState** a new entry per
new-entry commit, **replaceState** for replaces/redirect fixups, handle `popstate` by
traversing the engine.

- **Engine patch (small)**: `emitUrlSignal` (`BibPageClients.h`) doesn't say *what kind* of
  navigation fired it — new entry vs. replace vs. traversal look identical, so the viewer
  can't know whether to push or replace. All dispatch sites funnel through that one function;
  add a `kind` and a back-forward `index` (`backForward().backCount()`) to the JSON. Additive
  fields — update the `bibChrome` docs in `bib_abi.h` (~line 233) + the abi.mjs mirror;
  incremental rebuild + restage (~90 s, engine-build.md fix 6).
- **Viewer mirror**: store `{index}` in `history.state`; on `popstate`, delta = target index −
  current → `bib_go(delta)`, with an echo-suppression flag so the resulting `url` signal
  *replaces* (fixing up redirect divergence) instead of pushing. Serialize rapid popstates.
  Fallback: if the engine can't traverse there (post-crash/reload, empty BackForwardList),
  `bib_load_url` the entry's `?url=` — every mirrored entry carries a real URL, so any of
  them cold-boots correctly.
- **Input pass-through**: the canvas currently swallows Alt+←/→ (only Ctrl/Meta combos are
  exempt in `wireInput`) and forwards all mouse buttons with `preventDefault`, so native
  shortcuts and mouse back/forward buttons (3/4) never fire. Exempt Alt+arrows, buttons 3/4,
  probably F5.
- Native back past the first nested entry correctly leaves the sandbox to whatever preceded
  it — desired semantics, for free. Forward-pruning on nav-from-mid-stack matches naturally
  (pushState prunes forward entries like the engine does).

## Step 3 — native reload (free once step 1 lands)

Reload re-navigates `viewer.html?url=<current>` → engine reboots on the right page. Ctrl+R
already passes through to the host. Behavior change to accept: custom reload was `bib_reload`
on a live engine; native reload is a full engine reboot (~0.4–0.6 s) and drops the engine-side
back/forward stack — the popstate fallback covers traversal afterward, one full boot per step
(bfcache is deliberately blocked).

## Deletions & collateral

- Remove the three buttons from `viewer.html` + wiring/disabled-state code in `viewer.mjs`
  (keep URL bar, progress, title, and `__bs.state.canGoBack/Forward` for tests).
- Tier-2 chrome scenario (`test/tier2/scenarios.test.mjs` "chrome: URL bar tracks…") clicks
  `#back` — rewrite to drive native history (`history.back()` / harness goBack), plus assert
  `tab.url` tracks nested navigation (doubles as the escape-hatch regression test).
- Notes: ui.md chrome/escape-hatch sections; README status line ("back/forward/reload via
  real BackForwardList").

## Risks

- **History-API throttling**: Chrome rate-limits pushState/replaceState (~100 per 10 s). A
  guest SPA hammering pushState could get calls silently dropped, leaving some mirrored
  entries slightly stale — the load-URL fallback degrades gracefully; coalescing replace-kind
  signals is cheap insurance.
- **Traversal speed**: same-document popstate (common case, viewer alive) is instant via
  `bib_go`; cross-document traversal (after going native and back, or after reload) is a full
  engine boot per step.
- Security: strict improvement — escape rule keyed on the *live* host; entries stay
  extension-origin; pushed URLs are always built from the engine's true URL.
