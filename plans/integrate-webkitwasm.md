# Plan: integrate WebkitWasm into this repo

Absorb `engine/WebkitWasm` (currently a separate git clone of theogbob/WebkitWasm, local branch
`browsception`, 8 fork commits) into the browsception repo as plain tracked files. It's a hard
fork: upstream is dormant (last commit 2026-07-16) and we've already rewritten the core seams
(networking, presentation, history). After this, one repo = one history = engine and extension
versioned together; the ABI (`src/abi/bib_abi.h` ⇄ engine) changes atomically.

Decisions already made (user):
- **Squash import, no history preserved, no backup fork.** Losing the inner-repo commits is fine.
- **Prune hard**: their CLAUDE.md, recaps, README, docs, spikes — anything not valuable to a hard
  fork with our workflow. Load-bearing doc content gets distilled into `notes/` first.
- **Licensing**: user opened an upstream issue asking theogbob to clarify. Until resolved, mark
  webkitwasm-derived files as ambiguously licensed in an adapted `engine/WebkitWasm/LICENSING.md`
  (their original text kept as the base; add: what we imported, from which sha, what's been
  rewritten since, pointer to the upstream issue).

## Hard constraint: no full engine rebuild

The 12 GB gitignored build state (`engine/WebkitWasm/third_party/` = WebKit clone + emsdk +
wasm-sysroot; `engine/WebkitWasm/build/` = CMake/ninja graph, 7.4k objects) has **absolute paths
baked in** (CMakeCache, ninja deps, emsdk config, sysroot .pc files). Moving or renaming any of it
forces a ~1.5 h rebuild and risks bootstrap yak-shaving.

Therefore: **track the sources at their current on-disk paths.** `engine/WebkitWasm/` stays the
directory name; we just delete its `.git` and start tracking its source files in the main repo.
Every path string the build graph knows stays byte-identical; incremental iteration stays ~2–3 min.
(Flattening `engine/WebkitWasm/` → `engine/` is a deferred cosmetic follow-up; do it only when a
from-scratch rebuild is happening anyway. Noted in roadmap, not part of this plan.)

## Target state

Tracked in the main repo (net new ~a few MB after pruning):

```
engine/WebkitWasm/
  src/embedder/        # C++ embedder (Bib* clients, main.cpp, embedder.cmake)
  src/patches/webkit-emscripten.patch   # cumulative diff vs pinned upstream WebKit
  tools/               # bootstrap.sh, build-webcore.sh, build-deps/, export-webkit-patches.sh,
                       # dev-server.mjs, + whichever gate/diagnostic scripts survive the audit
  web/                 # browser.html dev harness, bib-net.js, engine-pre.js (+ surviving assets)
  LICENSING.md         # adapted: provenance + ambiguous-license marker
  README.md            # short: what this dir is, fork provenance, pointer to notes/engine-build.md
```

Gitignored (replace the current blanket `engine/` ignore):

```
engine/WebkitWasm/third_party/
engine/WebkitWasm/build/
engine/WebkitWasm/node_modules/
engine/artifacts/
engine/cmake-3.31.7-linux-x86_64/
engine/logs/
engine/.build.lock
engine/.build.owner
```

(`engine/gate-demo.mjs`, `engine/smoke-example.mjs` — ours, from spikes: audit; move into
`engine/WebkitWasm/tools/` or delete if superseded by `tools/smoke-*.mjs`.)

## Steps

### 1. Preconditions (main checkout)
- Engine tree state committed on the inner branch? Doesn't matter for history (squash), but the
  **working tree content** is what gets imported — make sure it's the state that built the current
  artifact. Run `tools/export-webkit-patches.sh` so `src/patches/webkit-emscripten.patch` matches
  the live `third_party/WebKit` working tree (57 dirty files there are *reconstructible from the
  patch only* — this is the one place data loss is possible; verify the exported patch applies
  clean to the pinned WebKit sha before deleting anything).
- Record provenance while the inner `.git` still exists: upstream base sha, our branch head sha,
  upstream URL → goes into `LICENSING.md`/`README.md` text.
- `bash tools/build-engine.sh --snapshot-only` so `engine/artifacts/latest` is current.

### 2. Distill docs → notes/
Read before deleting; merge anything load-bearing, then drop the originals:
- `docs/` (archive/research/summaries), `BUILD.md`, `README.md` → most build knowledge is already
  in `notes/engine-build.md`; fold in anything missing (dep quirks, pin rationale, known issues
  like video support).
- `recaps/` (30+ session recaps) → skim for still-relevant known-issue/why-decisions content;
  expected yield is low (superseded by our notes); then delete.
- Their `CLAUDE.md` → delete (our workflow governs now).
- Update `notes/engine.md` + `notes/README.md`: engine is now in-repo; drop "fork branch in
  engine/WebkitWasm" language.

### 3. Prune (audit each, then delete)
- Certain deletes: `CLAUDE.md`, `recaps/`, `docs/` (post-distill), `web/vendor/wisp-client.js`
  (wisp path deleted from engine), `package-lock.json` + wisp dependency.
- Audit: `web/vendor/binaryen.js` (28k lines — referenced by wb-spike only? delete with spike),
  `src/spike/` + `web/wb-spike*` + `web/gpu-spike.html` (upstream spikes), `web/jsc/`, `web/media/`
  + `media-stub.js`, `web/gate*` pages and `tools/gate*-test.mjs` + one-off diagnostics
  (`google-login-repro`, `smoke-modern-site`, `urlbar-test`, …). Keep what our smokes/debug loop
  actually uses; our tier-2 suite supersedes most gates. **Keep**: `tools/dev-server.mjs`,
  `web/browser.html`, `web/bib-net.js`, `web/engine-pre.js` — `tools/smoke-{browse,bridge,leak,fixtures}.mjs`
  drive the engine through them.
- `package.json`: keep a minimal engine-local one only if `npm --prefix` install is still needed
  (build-engine.sh:113 installs it for dev-server?). dev-server.mjs is plain node — if it and the
  surviving tools need no deps, delete package.json and drop the `npm --prefix` step; playwright
  comes from the root repo's node_modules in our smoke tools already.

### 4. The import
- `rm -rf engine/WebkitWasm/.git` (and `.gitignore` inside it, after merging its entries into ours).
- Rewrite root `.gitignore` per target state above.
- `git add engine/` — verify `git status` shows only intended files (nothing from third_party/,
  build/, artifacts/). Single commit: "absorb WebkitWasm fork (from theogbob/WebkitWasm @ <sha>)".

### 5. Tooling updates
- `tools/build-engine.sh`:
  - Drop step 0 (`git clone theogbob/WebkitWasm`) — sources are tracked; assert
    `$W/src/embedder/main.cpp` exists instead.
  - `snapshot()`: stamp from the **main repo** instead of the inner repo:
    `SHA=$(git -C "$MAIN_ROOT" log -1 --format=%h -- engine/)`,
    dirty = `git -C "$MAIN_ROOT" status --porcelain -- engine/` non-empty. Keep meta.json keys
    (rename wkw_* → engine_*; update the one consumer, stage-engine.mjs, if it reads them).
  - **WebKit-patch drift guard**: after a successful build, run `export-webkit-patches.sh` and
    warn loudly if the patch file changed (means the WebKit working tree has edits not yet
    captured in tracked state).
- `tools/stage-engine.mjs`, `tools/lib/paths.mjs`, smoke tools: **no path changes needed**
  (everything already resolves `engineRoot/WebkitWasm`). Update stale comments only.

### 6. Worktree contract (the part that must keep working)

Invariants preserved, unchanged from today:
- Physical build state (`third_party/`, `build/`) exists **only in the main checkout** — the
  ignored dirs simply don't materialize in worktrees. Nothing ever builds the engine per-worktree.
- `build-engine.sh` from any checkout resolves `MAIN_ROOT` via git common dir and builds the main
  checkout's tree under the existing flock. Worktrees consume engine bits exclusively via
  `engine/artifacts/` snapshots hardlink-staged into `src/engine/` (wt-setup/stage-engine,
  unchanged).
- `npm test` in a fresh worktree stays engine-free (tiers 0–1); `test:tier2` uses the staged
  artifact.

New wrinkle to handle: engine **sources** are now tracked, so every worktree has its own copy —
but builds always compile the **main checkout's** working tree. A worktree claude editing
`engine/` locally and running build-engine.sh would silently build main's (different) sources.
Mitigations:
- **Rule** (worktrees.md + CLAUDE.md): engine source edits happen in the main checkout's working
  tree only, committed there directly. Worktree branches carry JS-side work. "One line of engine
  work at a time" stands. For coupled ABI+engine changes: engine half in main checkout, JS half in
  the worktree (same repo now, merged by the user's scripts).
- **Guard** in build-engine.sh: when `checkoutRoot != MAIN_ROOT`, `diff -rq` the invoking
  checkout's tracked engine sources (`src/ tools/ web/`, a few MB — fast) against main's; on
  mismatch, abort with "worktree engine/ differs from main checkout — build compiles main's
  sources; edit there (or pass --main-sources to proceed)".

### 7. Docs/notes updates
- `notes/worktrees.md`: engine-work protocol rewrite per §6 (edit in main checkout, commit to main
  repo, patch-export before ending session — now enforced by the build guard).
- `notes/engine-build.md`: paths/provenance intro, drop "clone upstream" step, snapshot stamping
  change.
- `notes/README.md` index + status blurb; `notes/engine.md` fork framing.
- Root `CLAUDE.md`: engine bullet — sources tracked in-repo, build state shared singleton in main
  checkout, don't edit engine/ from worktrees.

### 8. Validation gates
1. `git status` clean-ish in main checkout; fresh `git worktree` shows engine sources present,
   no third_party/build, `npm test` passes with zero engine involvement.
2. Touch a comment in `src/embedder/main.cpp` → `bash tools/build-engine.sh` → incremental
   (~2–3 min), snapshot lands with main-repo sha stamp; `stage-engine` + `npm run test:tier2`
   pass in a worktree.
3. Worktree guard: dirty a worktree's engine file → build-engine.sh from there aborts with the
   message.
4. Patch-drift guard: touch a `third_party/WebKit` file → build → warning fires.
5. `tools/smoke-mvp.mjs` (or smoke-browse) still green against the restaged artifact.

### Deferred / out of scope
- Flattening `engine/WebkitWasm/` → `engine/` (needs a full rebuild or symlink surgery; only
  worth bundling with an intentional from-scratch rebuild). Add to roadmap.
- Licensing resolution — tracked by the user's upstream issue; revisit LICENSING.md then.
- Bootstrap reproducibility from a truly fresh clone (now: tracked sources + bootstrap.sh must
  recreate third_party from nothing; believed true, worth a one-time verification on a scratch
  machine someday). Add to roadmap.
