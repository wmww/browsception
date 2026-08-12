# Engine choice: WebKit

Decision: **WebKit, following the WebkitWasm lineage** — WebCore embedded WebKit1-style
(single-process), JSC in CLoop interpreter mode, Skia rendering, Emscripten toolchain.

## Why WebKit won

- **Demonstrated**: WebkitWasm (https://github.com/theogbob/WebkitWasm) already builds and runs
  real sites nested in a browser. Smallest delta between "exists today" and "what we need."
- Every load-bearing piece is an **upstream-supported configuration**, minimizing fork drift:
  - **CLoop** (portable C++ LLInt interpreter, `ENABLE_JIT=OFF`) — maintained, build-fixed through
    2024–25, lightly tested but alive. iOS Lockdown Mode is the consumer precedent for
    interpreter-ish WebKit being usable.
  - **Skia with CPU raster** — WPE/GTK moved to Skia in 2.46 (2024-09) and CPU raster is the
    *default on embedded*. Software-rendered WebKit is a shipping config, not a hack.
    (WebkitWasm currently presents via WebGL2/Ganesh — we switch to CPU raster + our own blit.)
  - **curl network backend** (WinCairo/PlayStation lineage) — avoids the GLib/libsoup platform
    layer, which is painful under Emscripten and unsupported upstream.
- Best real-web compatibility of any engine that can actually be ported (it's… WebKit).
- Single-process is achievable by embedding **WebCore directly (WebKit1-style)**. Do NOT try to
  port WebKit2: modern WPE/GTK hard-requires the UIProcess/WebProcess/NetworkProcess split
  (single-web-process mode was deprecated in 2.26).

Effort calibration from research: ~3–6 person-months to a solid demo starting from WebkitWasm,
~12–24 pm to robust quality. The dominant long-term cost is **out-of-tree port maintenance**: no
upstream CI covers `PORT=Emscripten` or CLoop-on-wasm, so every WebKit merge window can silently
break us. Budget for periodic rebase pain; pin to WebKit release tags, not main.

*Fork status: absorbed.* engine/WebkitWasm is a squashed hard-fork import (2026-08-12, upstream
base `825c260`, upstream dormant) — sources are tracked in this repo, no inner git. License
clarification pending: theogbob/WebkitWasm#1 (see engine/WebkitWasm/LICENSING.md). Upstream's
known issue at fork time: no video support. Sister project (gecko port): HeyPuter/firefox-wasm.

## What we changed relative to upstream WebkitWasm (1–3 landed; 4's font/ICU subsetting is roadmap)

1. **Rendering**: Ganesh/WebGL2 → **Skia CPU raster** into a plain framebuffer we own (no-GPU
   constraint; also removes their engine-owned GL context entirely). Investigate dirty-rect
   output so the blit can be partial.
2. **Networking**: drop curl + OpenSSL + SOCKFS + Wisp entirely. Replace the network backend at the
   `ResourceHandle`/NetworkDataTask boundary with a **host-fetch bridge** (see networking.md). This
   deletes a huge chunk of wasm surface (TLS stack, HTTP stack) and removes the external proxy
   server dependency. Note this moves TLS trust from in-guest OpenSSL to the host browser — fine
   for our threat model (see security.md).
3. **Storage**: keep their OPFS-backed cookies/localStorage approach, but namespaced per profile,
   isolated from host browser storage.
4. **Fonts**: bundle a Noto subset + default UI fonts; no system font access. ICU: subset the data
   (full ICU ~27 MB raw / 11 MB gz; subsettable to a few MB).

## Build shape

- Emscripten, wasm32 (not Memory64 — 4 GB is enough; Memory64 costs 10–100% on memory ops).
- pthreads + `PROXY_TO_PTHREAD` (COOP/COEP required on the hosting page — fine in our Chrome
  extension-page mode). Keep the single-threaded build working as a fallback for Firefox
  extension-page mode.
- `-fwasm-exceptions`, `-sSUPPORT_LONGJMP=wasm` (both solved problems in 2026 Emscripten).
- Avoid Asyncify (≈50% size/CPU overhead at engine scale). Sync-over-async where needed via
  blocking a pthread on Atomics (the bridge does this for resource loads); JSPI is Chrome-shipped
  if we ever need it, but atomics-blocking is more portable.
- Expect a ~10+ GB build tree; CI on a beefy self-hosted runner.

## JS performance reality

- CLoop is roughly **10x slower than JIT-ful JSC** (native LLInt ~7.5x; CLoop worse; Arm measured
  ~10x). Ordinary pages fine; heavy SPAs sluggish. This is the accepted floor.
- No JIT-in-wasm, ever (attack-surface decision, not a feasibility one — runtime wasm-module
  generation would reintroduce codegen surface and require instantiate rights).
- If we ever need more JS speed, the proven no-JIT path is SpiderMonkey-style **AOT partial
  evaluation** (Fastly's PBL + weval: 2.2–4.4x over interpreter). For JSC there is no equivalent
  today; treat as research direction, not plan-of-record.

## Alternatives (ranked at decision time, for the record)

| Engine | Verdict | Notes |
|---|---|---|
| **Gecko** (fork HeyPuter/firefox-wasm) | strong #2; lowest absolute effort (2–6 pm adopt) | Working demo, MPL. But: whole-Firefox port (233 MB wasm), officially-untested single-process path, heavier maintenance. Revisit if WebKit path stalls. |
| **Ladybird** | best philosophical fit, wrong year | Interpreter-only-by-design LibJS, CPU-first Skia, >90 % WPT (late 2025). But the portable C++ interpreter was **deleted in 2026** (AsmInt is x86_64/AArch64-only asm DSL — we'd resurrect the C++ one or write a wasm DSL backend), Rust migration churn began 2026-02, and the repo is maintainers-only → permanent fork. 8–15 pm to demo. |
| **Servo** | pass | Best process/thread shape (single-process default, embedding API on crates.io), but SpiderMonkey-under-Emscripten-with-pthreads is its own 6–12 pm project (wasi builds don't compose with threaded Emscripten), WebRender needs swgl (x86/NEON intrinsics, unproven on wasm SIMD), ~62 % WPT. 18–36 pm. |
| **Blink/Chromium** | impossible | V8 has no wasm backend even for AOT builtins (mksnapshot emits native code; emscripten-core/emscripten#9314 wontfix). Plus mandatory multiprocess/Mojo. Not an effort question. |
| NetSurf / litehtml / lexbor / Blitz | only if goals shrink to "render documents" | No or minimal JS/DOM. Blitz+Stylo is the interesting one (Kitesurf uses it server-side) but has no script runtime. |
| **Kitesurf** (Cloudflare) | watch | Announced 2026-08-06, wasm-native, Blitz+Stylo+Boa, 215k WPT passes, open-sourcing promised. If it becomes embeddable client-side it's a dramatically smaller nested engine. Re-evaluate when source drops. |

## Integration seams: the ABI (1.1, done)

The versioned contract is **src/abi/bib_abi.h** (+ JS mirror src/abi/abi.mjs; tier-0 test keeps
them in sync). Shape follows the embedder's existing conventions: `extern "C"` exports in
(self-proxying to the engine pthread, fire-and-forget), `Module.*` hooks out (page-scope via
MAIN_THREAD_ASYNC_EM_ASM, worker-scope via plain EM_ASM), pointers cross via the shared wasm heap
with explicit ownership rules. Covers lifecycle/boot-config, viewport resize + DPR, input,
the fetch bridge (async, credit-window flow control — see networking.md), chrome signals
(multiplexed `bibChrome(kind, json)`), and the async `bib_query` channel backing the `__bs`
dev/test hook. Find/audio/IME/touch are reserved names, post-MVP.

Engine-side gaps the ABI deliberately papers over until 1.2/1.3 land (per the embedder survey):
resize does not exist yet (800×600 hard-coded), chrome signals are greenfield
(`BibFrameLoaderClient`/`ChromeClient` overrides needed), boot config today is ~14 separate
blocking `Module.bib*` reads to collapse into one `Module.bibConfig` JSON read, and presentation
must move from bibBlit/putImageData + GPU-bitmap paths to the single `bibFrame` heap-framebuffer
push. The stable seam for the network transplant is `BibResourceLoad`'s WebCore-facing callbacks
(`didReceiveResponse/Buffer/FinishLoading/Fail` in EmbedderStrategies.cpp) — everything below it
(CurlRequest/CurlStream/scheduler patches/SOCKFS/wisp) is deletable in one cut; cookie assembly
(`appendEmbedderCookieHeader`/`storeResponseCookies`) and hand-rolled redirect logic stay
engine-side, exactly matching the bridge design.
