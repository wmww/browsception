# Roadmap (post-MVP)

MVP shipped 2026-08-10 (see README § Status). This absorbs the surviving parts of the retired
plans/mvp.md plus loose ends carried out of Phases 1–2.

## Fast-follows (rough order)

1. Clipboard (copy/paste text), find bar (engine findString), file upload, downloads.
2. IME/composition via hidden-input-at-caret (rendering-input.md) — the big input investment.
3. Popups/window.open → new viewer tabs; dialogs (alert/confirm/prompt/auth) as viewer modals.
4. Audio via AudioWorklet ring buffer.
5. Session restore, history, list import/export polish.
6. ~~Firefox port~~ landed 2026-09-09 (one worker-hosted no-SAB link on both browsers). Left:
   a Firefox residual question — whether dynamic DNR rules apply at browser startup before the
   event page runs (not probeable with a temporary install; the sweep covers it either way) —
   and real-site smokes on Firefox (Chrome-only so far).
7. Perf: dirty rects, scroll fast-path, engine tile cache tuning, startup snapshotting. The
   large-framebuffer present ceiling's natural next step is now an OffscreenCanvas presenter
   inside the engine worker (rendering-input.md option 2).
8. **Host-side tiled compositing in the shim** (from the firefox-wasm comparison, prior-art.md):
   engine paints tiles a bit larger than the viewport, the shim owns the scroll offset and
   composites — APZ-like decoupling of scroll from content paint without giving the engine a GPU
   (blit-only WebGL in the *shim* is allowed: fixed trusted shader, engine controls pixels only).
   Highest-value smoothness item available to us. Related cheap wins: get image decode off the
   engine thread; build libjpeg-turbo with SIMD (engine-internals.md).

Never: printing, DRM, nested GPU/JIT.

## Cleanups & untested corners

- WebSocket bridging (engine-side, over a host WS) — after the curl cut this is the ONLY
  possible guest-WS path; today `new WebSocket()` fails cleanly everywhere. Design sketch in
  networking.md; WebCore's WebSocketHandshake/Frame/DeflateFramer are still compiled in, so a
  channel replacing `BibWebSocketChannel` can reuse them.
- Optional: drop libcrypto too, if PAL's CryptoDigest gets a small vendored SHA/MD5 backend —
  it is the last piece of the old TLS tier still on the link.
- Flatten `engine/WebkitWasm/` → `engine/` — cosmetic; only with an intentional from-scratch
  rebuild (build graph has absolute paths baked in).
- One-time verification that a truly fresh clone bootstraps: tracked sources + bootstrap.sh must
  recreate third_party/ from nothing (believed true, unverified since the import).
- dpr≠1 rendering untested; frame-cost measurement pending (`bib_query` "metrics").
- Dev-harness transport has no request timeout (dev-only; extension bridge has the idle guard).
- MDN telemetry CORS preflights fail loudly in-engine (harmless; blocklist candidates).
- Startup race is a documented hard limit, not an issue: one navigation per browser start executes
  natively for ~100 ms before the sweep (security.md § Startup race).
- Open issues: guest-JS wedge, engine-renders-stale-input-state, rcap budget, viewer URL scheme (issues/).

## Standing risks

| Risk | Signal | Fallback |
|---|---|---|
| CLoop too slow for heavy sites | real-site browsing | Accept + document; long-term AOT research (weval-style). Switching to Gecko does NOT buy JS speed — its PBL measured slower than CLoop (engine.md) |
| Per-instance memory blows past ~2 GB | usage measurement | WebKit cache tuning, single-tab-at-a-time mode, tab discard |
| Store review rejects broad permissions | submission | Ship allowlist/per-site-activation build; self-host crx/unpacked |

## Working agreements (from the MVP plan)

- Engine fork tracks WebKit **release tags**; rebases are scheduled work, not drive-by.
- Every shim import added gets a line in security.md's capability accounting.
- Test growth policy: a new automated test must catch a new *class* of failure; prefer adding
  probes to existing scenarios over adding scenarios.
- Real-site smokes (tools/smoke-browse.mjs, tools/smoke-mvp.mjs) are manual/agent-run and
  sparing, never CI (testing.md guardrails).
