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
(`--sync-webkit` resets the WebKit tree; hardlinks, snapshots and the CMake cache all
tolerate a vanished checkout).

- `node_modules` → `cp -al` hardlink-clone from the main checkout (falls back to `npm ci` if the
  lockfile differs).
- `src/engine/` → hardlinked from the engine snapshot matching this checkout (`tools/stage-engine.mjs`).
- Nothing else needed: `test/fixtures/ca` self-generates; `src/manifest.json` is committed.

## Shared vs per-checkout

| Resource | Where | Sharing |
|---|---|---|
| engine build state (`engine/WebkitWasm/{third_party,build}`, ~12 GB, gitignored) | main checkout only | singleton; resolved via git common dir (`tools/lib/paths.mjs`), build serialized by `engine/.build.lock` (flock; owner in `.build.owner`). Any checkout can *build its own sources* against it (below) |
| `third_party/WebKit` working tree | main checkout | singleton with **one** patch loaded at a time; which one is recorded in `engine/.webkit-patch.applied` (+ `.owner`). Builds from a checkout whose tracked patch differs are refused until `--sync-webkit` |
| `engine/artifacts/<stamp>/` | main checkout | immutable snapshots of `embedder.{js,wasm}` + meta.json (`source_hash` = hash of the sources built, plus checkout/branch/sha/dirty/pthread), newest 5 kept, `latest` symlink |
| `src/engine/` | per checkout | hardlinks into a snapshot (~0 disk; Chrome can't reliably follow symlinks, hardlinks are fine). Pruning a snapshot never breaks staged copies — hardlinks keep inodes alive |
| `node_modules` | per checkout | hardlink-clone of main's |
| test/dev-server ports | per checkout | derived block of 16 from checkout-path hash (`test/harness/ports.mjs`, base 21000–28999, override `BS_PORT_BASE`). Fixture pages that need live ports use `__HTTP_PORT__`/`__HTTPS_PORT__` placeholders substituted by server.mjs |

Port isolation matters: with a fixed port, one worktree's harness would silently talk to another
worktree's fixture server (health check passes, oracle cross-contaminates).

## JS-only work (the common case)

`wt-setup` + `npm test` / `npm run test:tier2` — no engine build involved. Concurrent worktrees
don't interact at all.

## Engine (C++) work

Edit `engine/WebkitWasm/{src,web}` **on your own branch in your own worktree** and build from
there: `bash tools/build-engine.sh` compiles *this checkout's* sources against the main
checkout's shared build tree. A coupled engine+JS change is one branch, one review, testable in
place.

Why it's cheap: everything checkout-specific flows through one CMake cache var
(`EMSCRIPTEN_EMBEDDER_CMAKE` → `src/embedder/embedder.cmake`, which also pulls
`web/engine-pre.js` via `--pre-js`), and no WebCore object includes anything from our `src/`.
Repointing it reconfigures and rebuilds the 5 embedder TUs + link only. Measured: **~1.5 min**
for a build from a worktree, 7 ninja edges (3 when switching back, since both checkouts' objects
stay in the graph).

1. `bash tools/build-engine.sh` — from any checkout; takes the lock, waits with a message if
   another build is running. Flags: `--sync-webkit` (below), `--force` (skip the fast path),
   `--snapshot-only`.
   - **Fast path**: if a snapshot's `source_hash` already matches this checkout's engine sources,
     it prints it and exits (~0.7 s). A fresh JS-only worktree costs nothing out of the gate.
2. `node tools/stage-engine.mjs` in your checkout picks the newest snapshot whose `source_hash`
   matches it. No match → it stages `latest` with a loud warning naming what that was built from
   (legit for JS-only worktrees; a real mismatch is now visible instead of silent). `--from
   <stamp>` pins explicitly.
3. **Dep tier / bootstrap edits are main-checkout work**: `tools/bootstrap.sh` and
   `tools/build-deps/*` always run from main and only touch `third_party/`.

### WebKit-tree changes (`third_party/WebKit`)

The WebKit working tree is a singleton; the only tracked record of our edits is each checkout's
`src/patches/webkit-emscripten.patch`, and `engine/.webkit-patch.applied` records whose patch is
loaded.

- Your patch == `.applied` → the tree is yours: live edits there are captured into **your**
  checkout's patch by the pre-build export (with a warning if they weren't tracked yet), so your
  branch carries them.
- Your patch != `.applied` → a build is **refused** (it would compile another branch's WebKit
  sources). `bash tools/build-engine.sh --sync-webkit` reloads the tree with your patch and
  proceeds. It discards uncommitted WebKit-tree edits, and it preserves mtimes for files whose
  content is unchanged by the switch — measured 66/67 files untouched, 9 ninja edges, ~1.5 min
  (a naive `git checkout .` costs ~13 min / 960 edges, which is why that code exists).
- If nothing needs building (fast path hit), a foreign patch is just noted, not an error.

**Standing constraint**: only one *divergent* line of WebKit-tree work at a time — two branches
with different patches ping-pong the tree (~1.5 min each way, correct but wasteful). Coordinate
via the user. (True parallelism would need a WebKit `git worktree` + its own build dir per
workspace: ~45 min cold build each. Not built; escalate deliberately.)

JS-side claudes are immune to concurrent engine rebuilds: staged artifacts are hardlinked
snapshots, never the live build output (a relink can rewrite output in place).
