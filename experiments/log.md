# Experiments log

Append-only lab notebook (notes/testing.md § Lab notebook). Raw record here;
distilled conclusions get promoted into `notes/` in the same change.

---

## 2026-08-09 — Phase 0 spikes: harness, networking (0.2), interception (0.3)

**Setup**: Chromium 150.0.7871.186 (Arch), Node 26.5, playwright-core 1.62 driving
system Chromium headless; fixture server + oracle (`test/fixtures/server.mjs`); probe
extension `spikes/probe-ext/` (pinned id `niccekiafgllmlhjohknnkaemmedldgo`).

**Headless parity (open-questions #19)** — hypothesis: headless=new supports our whole
stack. Ran `test/tier1/parity.test.mjs`. Result: PASS on all four load-bearing pieces
(unpacked extension + SW, manifest COOP/COEP → crossOriginIsolated + SAB + shared wasm
memory + worker Atomics, DNR main_frame regexSubstitution redirect, host-resolver-rules
with two mappings incl. port override). CI can be pure headless; guibox fallback not
needed for tiers 0–1.

**Networking probes (0.2)** — scripts (throwaway, scratchpad): probe-net, probe-wr,
probe-rederr, probe-pna; graduated into `test/tier1/bridge-probe.test.mjs` (7 tests).
Full result table + decisions promoted to **notes/bridge-probe.md**. Headlines:
redirect:'manual' is opaque even for extensions; Set-Cookie invisible to fetch but fully
readable (incl. HttpOnly, per hop) via observational webRequest `extraHeaders`;
redirect:'error' + webRequest gives engine-driven redirects (3xx captured, next hop never
on wire); DNR modifyHeaders rewrites UA/Cookie/Referer/Origin scoped by
initiatorDomains=extension, zero leakage to native traffic; Chrome applies no PNA to
extension fetches (guard list is alone); observed cross-origin cookie-carry hazard with
host-followed redirects → per-request cookie rules + engine-driven hops.

**Interception matrix (0.3)** — `test/tier1/interception.test.mjs` (6 tests): static
blacklist redirect fires with SW force-killed (CDP Target.closeTarget); http and https
both intercepted; attachment/download navigations redirect at request time (response
type irrelevant); history entries hold viewer URLs, back/forward clean;
whitelist-mode shape works (static catch-all + priority-10 allow + priority-100
session escape hatch scoped to tabId — other tabs unaffected); view-source: of an
intercepted domain redirects its inner request (invariant holds).

**guibox recipe check (0.5)** — launched windowed Chromium + extension in guibox,
screenshot, F5 via wdotool, screenshot again, stop. Recipe works as documented.
FOUND: first navigation on a fresh profile races static ruleset registration and loads
natively (reload intercepts) → `issues/first-navigation-races-ruleset-registration.md`.

**Engine build (0.1)** — WebkitWasm cloned (repo is ~3.5 MB of scripts/patches, not a
WebKit fork; `main` is the pthread branch now, `wb1-pthread` is a stale snapshot).
Pins: WebKit `webkitglib/2.52 @ aec9d2ad95`, Emscripten 6.0.0. bootstrap + build
running in background (`engine/logs/build-0.1.log`) — still in WebKit clone stage at
time of writing.

## 2026-08-09 — Spike 0.4: blit + input harness (delegated agent)

Built spikes/blit/ (viewer skeleton + fake SAB engine worker + dep-free CDP bench).
Measured headless (SwiftShader) AND windowed guibox (AMD 890M/radeonsi), Chromium 150:
WebGL2 full-frame 0.65–0.68/1.31–1.02 ms avg (1080p/1440p); putImageData 1.3–3.2 ms and
45 fps at 1440p headless (only failing config); dirty rows (~10%) 0.10–0.22 ms everywhere;
input round-trip avg 5–14 ms p95 19–31 ms (rAF quantization), zero ring drops. Chromium
accepts SAB-backed views in texSubImage2D directly (scratch-copy fallback unused).
Decision → open-questions #10 answer; raw JSON in spikes/blit/bench/data/.

## 2026-08-10 — 0.1 fresh-bootstrap failure: dep-order bug in WebkitWasm

First full run of `tools/bootstrap.sh` on a truly fresh checkout died in
webcore-deps at freetype: `FT_REQUIRE_BROTLI=ON` but brotli is built by
curl-tier.sh, which bootstrap runs *after* webcore-deps (fontconfig↔freetype
forces that order). Upstream never hit it — their comment ("brotli is already
in the sysroot of every existing checkout") shows the brotli requirement
postdates their last fresh bootstrap. Workaround that keeps their scripts
untouched (all dep steps are idempotent): run curl-tier.sh once first — it
builds openssl→nghttp2→brotli→libpsl→curl and dies at fontconfig (missing
freetype, expected) — then re-run the normal bootstrap chain. Relaunched as
build-0.1b.log. Goes in the 0.1 build-reproduction notes; worth reporting
upstream.

## 2026-08-10 — 0.1 second fresh-bootstrap failure + fix; bootstrap complete

After the brotli-ordering workaround, curl-tier died at fontconfig: fc-cache link
failed with undefined brotli symbols — libbrotlidec.a needs libbrotlicommon.a, but
brotli's `libbrotlidec.pc` declares it only in `Requires.private`, which non-static
pkg-config resolution drops (harmless with shared libs, fatal in a static-only wasm
sysroot). Same root cause as before: upstream's tree predates freetype-with-brotli, so
their fontconfig never linked brotli at all. Fix (documented, no upstream script edits):
promote the dep to public `Requires:` in the sysroot copy —
`sed -i 's/^Requires.private: libbrotlicommon/Requires: libbrotlicommon/'
wasm-sysroot/lib/pkgconfig/libbrotlidec.pc` — then rerun the idempotent chain.
Result: fontconfig built, `bootstrap complete` (build-0.1d.log). WebCore build now
running (BIB_JOBS=12). Both fixes + the curl-tier-first ordering go into the 0.1
reproducible-build script; report both upstream.

## 2026-08-10 — 0.1 two more host-environment fixes; WebCore compile started

- **Arch font paths**: build-webcore.sh stages DejaVu faces from the Debian path
  `/usr/share/fonts/truetype/dejavu/`. Arch keeps them in `/usr/share/fonts/TTF/`.
  Fix without touching the script: pre-stage `build/embedder-fs/` (9 faces +
  etc-fonts tree from the sysroot) so the script's guard skips its own staging.
- **CMake 4 incompatibility**: host cmake 4.4.0 fails configuring the pin at
  `WebKitMacros.cmake:311` (`_WEBKIT_TARGET_LINK_FRAMEWORK`) — unquoted empty
  `${_linked_into}` in an `if()`; only the Emscripten port leaves that property
  unset, and CMake ≤3.x tolerated it. No cmake pin in their decision-002. Fix:
  local CMake 3.31.7 binary in `engine/cmake-3.31.7-linux-x86_64/`, prepended to
  PATH for the build. CONFIGURE: OK; ninja running (BIB_JOBS=12, build-0.1f.log).

Fresh-bootstrap fix list for the 0.1 deliverable so far: (1) curl-tier before
webcore-deps for brotli, (2) libbrotlidec.pc Requires promotion, (3) font path
staging on non-Debian hosts, (4) cmake <4 required.

- **Ruby erb missing** (fix #5): Arch's ruby 3.4 no longer ships `erb` in the base
  package; WebCore's GenerateSettings.rb dies at `require 'erb'` ~1.7k targets in.
  Fix: `gem install --user-install erb`. Build resumed incrementally (build-0.1g.log).

## 2026-08-10 — 0.1 COMPLETE: engine built and verified

erb fix let the incremental build finish: NINJA OK, embedder.wasm 103 MB. Verified
with system Chromium headless: hello-demo gate PASS (exactBlue=20000, redGlyph=1962,
ticks alive), then https://example.com rendered through the engine over Wisp
(screenshot engine/logs/example-com.png; crossOriginIsolated true). Reproducible
build script: tools/build-engine.sh (5 fixes). Distilled → notes/engine-build.md;
open-questions #3 answered. WebCore compile itself ≈45 min wall at BIB_JOBS=12 —
much better than feared. Phase 0 exit gate: all five spikes done, tiers 0–1 green.
