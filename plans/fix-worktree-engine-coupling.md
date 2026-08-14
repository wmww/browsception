# Fix: worktrees can't carry coupled engine+JS changes

Fixes `issues/worktrees-break-on-coupled-engine-work.md`. Goal: one branch (in a
user-managed worktree) holds a whole coupled change — embedder C++, WebKit patch, JS,
tests — with the shared 12 GB build tree doing fast incremental builds for whichever
checkout invokes it. Per-worktree cost stays ~0 disk / ~2 s setup.

## Why this works

Everything the artifact depends on flows through one CMake cache var,
`EMSCRIPTEN_EMBEDDER_CMAKE` (see `src/embedder/embedder.cmake`): the 5 embedder TUs and
`--pre-js ../../web/engine-pre.js` resolve relative to it, and **no WebCore/WebKit object
includes anything from `engine/WebkitWasm/src`** (verified: the patch only adds the
deferred `include`). So repointing that var at a worktree's sources rebuilds only the
embedder target + relink (~2–3 min) — the exact cost of a normal embedder edit. The 7.4k
WebCore objects, third_party/, and the ninja graph stay shared and untouched.

Repoint via the **plain path** (cache-value change → reconfigure → new command lines →
ninja rebuilds). Do NOT use a stable symlink flipped between checkouts: ninja would
compare by mtime through the link, and a worktree file *older* than the last build's
output would silently produce a stale artifact.

## 1. build-engine.sh: build the invoking checkout's sources

- Delete the diff-against-main guard and `--main-sources`.
- Split "source checkout" from "build state" in `engine/WebkitWasm/tools/build-webcore.sh`
  and `export-webkit-patches.sh`: `BIB_TREE` (build/, third_party/, sysroot — always
  main's WebkitWasm) vs `BIB_SRC` (the invoking checkout's WebkitWasm; default `$ROOT` so
  standalone use is unchanged). build-engine.sh runs the **invoking checkout's** copies of
  these two scripts with both vars set. Bootstrap/dep-tier scripts keep running main's
  copies — they only touch third_party (document: dep-script edits are main-checkout work).
- `-DEMSCRIPTEN_EMBEDDER_CMAKE=$BIB_SRC/src/embedder/embedder.cmake`; the existing
  cache-sync loop in build-webcore.sh already reconfigures when the value changes.
  Optimization: if the cached path's checkout still exists and its `src/` + `web/engine-pre.js`
  are content-identical to the invoking checkout's, keep the cached path (JS-only worktrees
  that run a build don't churn the cache).
- pre-js is untracked by cmake (existing caveat): stamp `sha256(engine-pre.js)` next to
  the build dir and touch `main.cpp` when it changes, so pre-js edits relink automatically.
- Lock/serialization unchanged (`engine/.build.lock`, owner file now records the invoking
  checkout — it already records `$SCRIPT_DIR`).

## 2. WebKit-tree coupling: guard + deliberate switch

The shared `third_party/WebKit` working tree is still a singleton; its only tracked record
is the checkout's `src/patches/webkit-emscripten.patch`. Make the tree follow *whichever
branch is doing engine work*, safely:

- After each build's patch export, write `sha256(patch)` to `engine/.webkit-patch.applied`.
- Pre-build check: if the invoking checkout's tracked patch ≠ `.applied`, another branch's
  WebKit state is loaded → **refuse** with the owner info, unless `--sync-webkit` is
  passed, which resets the WebKit tree (`git checkout . && apply <checkout's patch>`) and
  updates `.applied`. Ninja cost of a switch = only the files the patch delta touches.
- If the patch equals `.applied`, live WebKit-tree edits are yours; the existing post-build
  export writes into **the invoking checkout's** `src/patches/` (BIB_SRC), so the branch
  carries the patch change. Missing `.applied` (first run): initialize from the current
  patch with a note.

Net: even patch-coupled changes live on one branch; truly parallel *divergent* WebKit work
remains one-at-a-time (unchanged standing constraint, now enforced instead of documented).

## 3. Artifact identity: hash-matched snapshots

- New `tools/lib/engine-src-hash.mjs`: sha256 over the build inputs of a checkout —
  `engine/WebkitWasm/src/**` (embedder + patches) + `web/engine-pre.js`, sorted. Single
  implementation, called from both build-engine.sh and stage-engine.mjs.
- `snapshot()`: record `source_hash`, invoking checkout path, its branch/sha/dirty (today
  it always stamps main's) and `BIB_PTHREAD` in meta.json. Fix the dedupe: `cmp` both
  `embedder.js` **and** `embedder.wasm` (a pre-js-only change currently gets skipped).
- build-engine.sh fast path: if a snapshot's `source_hash` + `.webkit-patch.applied`
  already match the invoking checkout, print it and exit — "no engine changes here" costs
  seconds, satisfying "fast out of the gate" for fresh worktrees.
- `stage-engine.mjs`: prefer the newest snapshot whose `source_hash` matches this
  checkout; else stage `latest` with a loud warning naming what it was built from and the
  fix (`tools/build-engine.sh`). `--from` still pins explicitly. Warn, don't refuse:
  a fresh worktree vs a dirty-main-built snapshot is a legit JS-only situation.

## 4. Fail fast when the engine isn't staged

Guard the harness (`test/harness/launch.mjs`): missing `src/engine/embedder.wasm` must
error "no engine staged — run tools/wt-setup.mjs" up front, not 13 scenario timeouts
with no hint. (An earlier draft added wt-setup calls to more entry points —
`prefixtures`, smoke scripts — but the `.wt-hooks/create` hook provisions worktrees at
birth, so those are unnecessary. npm's `pretest`/`pretest:tier2` hooks stay: idempotent,
~0.3 s when provisioned, and they cover non-helper checkouts like fresh clones.)

## 4b. Worktree lifecycle hooks (.wt-hooks/)

The user's worktree helpers run executables from the worktree's `.wt-hooks/` dir
(cwd = the worktree): `create` after creation, `done` before marked complete, `wipe`
before unmerged deletion. Only `create` is used (**already added**: runs wt-setup).
`done`/`wipe` were considered and rejected — a wipe leaves no shared state that the §2
pre-build patch guard doesn't already self-heal on the next build (abandoned WebKit-tree
edits get reset by `--sync-webkit`; hardlinks, snapshots, and the CMake cache all
tolerate a vanished checkout), and merge-time "was this built/tested" checks are
unreliable proxies (snapshot pruning) for what test runs already gate.

## 5. Docs / cleanup

- Rewrite `notes/worktrees.md` § Engine work: edit engine sources on your own branch in
  your own worktree; `bash tools/build-engine.sh` from there; `--sync-webkit` semantics;
  one active WebKit line at a time; dep-tier/bootstrap edits are main-only.
- Update the header comment in build-engine.sh; touch `notes/engine-build.md` if it
  restates the old protocol.
- Delete the issue (fold the "verified mismatch" example into worktrees.md if useful).

## Verification

1. Scratch worktree A: trivial embedder change (log string) → `build-engine.sh` from A:
   expect reconfigure + ~5 TUs + link (~2–3 min, check ninja log), snapshot with A's
   hash/branch in meta.
2. `stage-engine.mjs` in A picks the matching snapshot; in main it warns and stages latest.
3. Rebuild from main (no changes): cache repoints, only embedder rebuilds; then re-run
   build from main → instant "already built" via hash match.
4. Patch guard: fake a differing `src/patches` in A → build refuses; `--sync-webkit`
   applies and builds.
5. `npm run test:tier2` green in A against A's artifact.

## Non-goals

- Parallel *divergent* WebKit-tree builds (still escalate: per-workspace WebKit worktree +
  build dir, ~45 min cold each).
- Per-worktree build trees, ccache, copying third_party.
