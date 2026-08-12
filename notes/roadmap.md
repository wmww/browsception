# Roadmap (post-MVP)

MVP shipped 2026-08-10 (see README § Status). This absorbs the surviving parts of the retired
plans/mvp.md plus loose ends carried out of Phases 1–2.

## Fast-follows (rough order)

1. Clipboard (copy/paste text), find bar (engine findString), file upload, downloads.
2. Guest-wasm shim (binaryen wasm2js) — guest wasm currently sees CompileError (2.1 deferral).
3. IME/composition via hidden-input-at-caret (rendering-input.md) — the big input investment.
4. Popups/window.open → new viewer tabs; dialogs (alert/confirm/prompt/auth) as viewer modals.
5. Audio via AudioWorklet ring buffer.
6. Session restore, history, list import/export polish.
7. Firefox port: single-thread build first; then StreamFilter mode B (real URL + FF threads).
8. Perf: dirty rects, scroll fast-path, engine tile cache tuning, startup snapshotting.

Never: printing, DRM, nested GPU/JIT.

## Cleanups & untested corners

- Delete curl/wisp from the engine (superseded by the bridge; still linked): planned in
  detail in `plans/remove-wisp-curl.md`. WebSocket bridging over host WS remains engine-side
  future work (networking.md) and becomes the only guest-WS path after the cut.
- Flatten `engine/WebkitWasm/` → `engine/` — cosmetic; only with an intentional from-scratch
  rebuild (build graph has absolute paths baked in).
- One-time verification that a truly fresh clone bootstraps: tracked sources + bootstrap.sh must
  recreate third_party/ from nothing (believed true, unverified since the import).
- Engine licensing: webkitwasm-derived files are ambiguously licensed pending
  theogbob/WebkitWasm#1; revisit engine/WebkitWasm/LICENSING.md when it resolves.
- dpr≠1 rendering untested; frame-cost measurement pending (`bib_query` "metrics").
- Dev-harness transport has no request timeout (dev-only; extension bridge has the idle guard).
- MDN telemetry CORS preflights fail loudly in-engine (harmless; blocklist candidates).
- Open issues: first-nav race residual (pre-sweep JS executes briefly), guest-JS wedge (issues/).

## Standing risks

| Risk | Signal | Fallback |
|---|---|---|
| CLoop too slow for heavy sites | real-site browsing | Accept + document; long-term AOT research (engine.md) |
| Per-instance memory blows past ~2 GB | usage measurement | WebKit cache tuning, single-tab-at-a-time mode, tab discard |
| Store review rejects broad permissions | submission | Ship allowlist/per-site-activation build; self-host crx/unpacked |

## Working agreements (from the MVP plan)

- Engine fork tracks WebKit **release tags**; rebases are scheduled work, not drive-by.
- Every shim import added gets a line in security.md's capability accounting.
- Test growth policy: a new automated test must catch a new *class* of failure; prefer adding
  probes to existing scenarios over adding scenarios.
- Real-site smokes (tools/smoke-browse.mjs, tools/smoke-mvp.mjs) are manual/agent-run and
  sparing, never CI (testing.md guardrails).
