# Ephemeral worktrees

The user's scripts create/merge worktrees under `.worktrees/wt_*`; multiple claudes may work in
parallel worktrees. Everything below makes that cheap: **never** build the engine from scratch in a
worktree, and never copy the 12 GB `engine/` tree. One branch can carry a whole coupled change
(embedder C++ + WebKit patch + JS + tests) — see § Engine work.

## Setup (once per fresh worktree, idempotent, ~2 s)

```sh
node tools/wt-setup.mjs     # also auto-runs via npm pretest/pretest:tier2 hooks
```

The user's worktree helpers also run executables from `.wt-hooks/` (cwd = the worktree):
`create` after creation (wired: runs wt-setup, so fresh worktrees are provisioned before
any agent touches them), `done` before a worktree is marked complete, `wipe` before
unmerged deletion. `done`/`wipe` are deliberately unused: nothing needs cleanup — an
abandoned worktree leaves no shared state that the next build doesn't self-heal
(the next builder's automatic WebKit-tree takeover resets the tree; hardlinks, snapshots
and the CMake cache all tolerate a vanished checkout).

- `node_modules` → `cp -al` hardlink-clone from the main checkout (falls back to `npm ci` if the
  lockfile differs).
- `src/engine/` → hardlinked from the engine snapshot matching this checkout (`tools/stage-engine.mjs`).
- Nothing else needed: `test/fixtures/ca` self-generates; `src/manifest.json` is committed.

## Shared vs per-checkout

| Resource | Where | Sharing |
|---|---|---|
| engine build state (`engine/WebkitWasm/{third_party,build}`, ~12 GB, gitignored) | main checkout only | singleton; resolved via git common dir (`tools/lib/paths.mjs`), build serialized by `engine/.build.lock` (flock; owner in `.build.owner`). Any checkout can *build its own sources* against it (below) |
| `third_party/WebKit` working tree | main checkout | singleton with **one** patch loaded at a time; which one is recorded in `engine/.webkit-patch.applied` (+ `.owner`). A build from a checkout whose tracked patch differs takes the tree over automatically and losslessly (§ WebKit-tree changes) |
| `engine/artifacts/<stamp>/` | main checkout | immutable snapshots of `embedder.{js,wasm}` + meta.json (`source_hash` = hash of the sources built, plus checkout/branch/sha/dirty/pthread), newest 12 kept, `latest` symlink. `engine/artifacts/keep/<stamp>/` is **pruning-exempt** (retention globs `artifacts/2*`): `cp -a` a notable build there and it stays runnable — `--list` shows keeps, `--from keep/<stamp>` stages one. That is the depth limit on retro-benchmarking (notes/perf-measurement.md § Retro-running) |
| `src/engine/` | per checkout | hardlinks into a snapshot (~0 disk; Chrome can't reliably follow symlinks, hardlinks are fine). Pruning a snapshot never breaks staged copies — hardlinks keep inodes alive, and `.staged-meta.json` lets stage-engine keep a still-matching staged copy whose snapshot was pruned instead of downgrading to `latest` |
| `node_modules` | per checkout | hardlink-clone of main's; the dev server mounts it at `/vendor` so harness pages can import npm deps (binaryen) |
| smoke harness (dev-server, `web/`, staged engine) | per checkout | ordinary tracked source, not build state — `tools/lib/dev-harness.mjs` serves **this** checkout's copy; only the build tree behind `stage-engine` is shared |
| test/dev-server ports | per checkout | derived block of 16 from checkout-path hash (`test/harness/ports.mjs`, base 21000–28999, override `BS_PORT_BASE`). Fixture pages that need live ports use `__HTTP_PORT__`/`__HTTPS_PORT__` placeholders substituted by server.mjs |

Port isolation matters: with a fixed port, one worktree's harness would silently talk to another
worktree's fixture server (health check passes, oracle cross-contaminates).

## Smokes and harness servers

`tools/smoke-*.mjs` run entirely out of **this** checkout via `tools/lib/dev-harness.mjs`:
its `engine/WebkitWasm/tools/dev-server.mjs`, its `web/` harness, and `/engine` mounted from
its `src/engine` (the hash-matched hardlink snapshot; `startDevServer` re-stages `--if-stale`
first). Nothing is served out of the main checkout's live `build/webcore/bin` — that holds
whichever checkout built last, and a relink rewrites it under a running smoke. Before this
(fixed 2026-08-13) a smoke from a worktree silently exercised main's harness and a neighbour's
engine.

Port blocks are *derived*, so two checkouts can hash to the same one. Both harness servers
therefore identify themselves and the clients refuse a stranger:

- fixture server `/__health` → `{checkout}`; `waitForOwnFixtureServer()` (ports.mjs) throws
  `.foreign` rather than adopting it, and `ensureFixtureServer()` rethrows instead of spawning
  a doomed second one. Silently sharing it would cross-contaminate the request oracle.
- dev server `/__whoami` → `{root, mounts}`; `waitForServers(urls, server)` checks it, and a
  dev server that dies on a busy port kills the smoke instead of letting it drive a neighbour's.

If you hit a collision, set `BS_PORT_BASE` in one checkout.

## JS-only work (the common case)

`wt-setup` + `npm test` / `npm run test:tier2` — no engine build involved. Concurrent worktrees
don't interact at all.

## Engine (C++) work

Edit `engine/WebkitWasm/src/` **on your own branch in your own worktree** and build from
there: `bash tools/build-engine.sh` compiles *this checkout's* sources against the main
checkout's shared build tree. A coupled engine+JS change is one branch, one review, testable in
place.

Why it's cheap: everything checkout-specific flows through one CMake cache var
(`EMSCRIPTEN_EMBEDDER_CMAKE` → `src/embedder/embedder.cmake`, which also pulls
`src/embedder/engine-pre.js` via `--pre-js`), and no WebCore object includes anything from
our `src/`. Repointing it reconfigures and rebuilds the 5 embedder TUs + link only.
Measured: **~1.5 min** for a build from a worktree, 7 ninja edges (3 when switching back,
since both checkouts' objects stay in the graph).

1. `bash tools/build-engine.sh` — from any checkout; takes the lock, waits with a message if
   another build is running. Flags: `--sync-webkit` (below), `--force` (skip the fast path),
   `--snapshot-only`.
   - **Fast path**: if a snapshot's `source_hash` already matches this checkout's engine sources,
     it prints it and exits (~0.7 s). A fresh JS-only worktree costs nothing out of the gate.
2. `node tools/stage-engine.mjs` in your checkout picks the newest snapshot whose `source_hash`
   matches it. No matching snapshot but the already-staged copy was hash-matched to these same
   sources (`src/engine/.staged-meta.json`) → it keeps the staged copy (its snapshot was pruned
   by other checkouts' builds; the bits are still right). Otherwise it stages `latest` with a
   loud warning naming what that was built from (legit for JS-only worktrees; a real mismatch is
   visible instead of silent). Artifact identity is first-class (an A/B run once measured a
   neighbour's engine because stamps looked alike, 2026-08-14):
   - stamps carry the builder: `<time>-<sha>[-dirty]-<checkout>`; `--list` shows every
     snapshot's branch/checkout/source_hash and which is staged/matching.
   - every staging action prints one provenance line (stamp, branch, checkout, source_hash),
     and engine-backed tests/probes print it at startup, so measurement logs self-attribute.
     They also warn if an engine build is running (concurrent ninja skews timings).
   - `--from <stamp>` pins explicitly (`--from mine` = newest built from this checkout); pinning
     another checkout's artifact is allowed — that's the A/B case — but warns by name. A pin is
     **sticky**: the pretest `--if-stale` re-run keeps it (with a reminder line) instead of
     silently swapping engines mid-experiment; a plain `node tools/stage-engine.mjs` unpins.
3. **Dep tier / bootstrap edits are main-checkout work**: `tools/bootstrap.sh` and
   `tools/build-deps/*` always run from main and only touch `third_party/`.

### WebKit-tree changes (`third_party/WebKit`)

The WebKit working tree is a singleton; the only tracked record of our edits is each checkout's
`src/patches/webkit-emscripten.patch`, and `engine/.webkit-patch.applied` records whose patch is
loaded.

- Your patch == `.applied` → the tree is yours: live edits there are captured into **your**
  checkout's patch by the pre-build export (with a warning if they weren't tracked yet), so your
  branch carries them.
- Your patch != `.applied` → your build **takes the tree over automatically and losslessly**:
  it first captures any live tree edits into the *recorded owner's* patch file (their branch
  keeps their work; if the owner checkout vanished and no checkout's patch accounts for the
  content, the edits land in `engine/webkit-rescue-<stamp>.patch` with a warning), then reloads
  the tree with your patch. The switch preserves mtimes for files whose content it doesn't
  change — measured 66/67 files untouched, 9 ninja edges, ~1.5 min (a naive `git checkout .`
  costs ~13 min / 960 edges, which is why that code exists). No coordination needed; divergent
  WebKit branches just pay the ~1.5 min switch per direction, serialized by the build lock.
- If nothing needs building (fast path hit), a foreign patch is just noted and the tree is left
  alone. Corollary: **before live-editing `third_party/WebKit`, own the tree** — run
  `bash tools/build-engine.sh --sync-webkit` (same lossless takeover, forced now). Editing a
  tree you don't own risks your edits being captured into the owner's patch instead of yours.
- Treat the patch file as the source of truth and the tree as a cache: if your live edits
  disappear from the tree (someone took it over), they're in your patch file; your next build
  reapplies them.

**Merge caveat**: two branches that both changed `webkit-emscripten.patch` will conflict as
ordinary git conflicts in a unified-diff file, which git merges badly. Resolution recipe: take
either side, build (loads that side's hunks into the tree), hand-apply the other side's
changes in the tree, build again — the export regenerates a clean combined patch.
(True tree parallelism would need a WebKit `git worktree` + its own build dir per workspace:
~45 min cold build + ~13 GB each. Not built; escalate deliberately.)

JS-side claudes are immune to concurrent engine rebuilds: staged artifacts are hardlinked
snapshots, never the live build output (a relink can rewrite output in place).
