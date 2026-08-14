# Ephemeral worktrees

The user's scripts create/merge worktrees under `.worktrees/wt_*`; multiple claudes may work in
parallel worktrees. Everything below makes that cheap: **never** build the engine from scratch in a
worktree, and never copy the 12 GB `engine/` tree.

## Setup (once per fresh worktree, idempotent, ~2 s)

```sh
node tools/wt-setup.mjs     # also auto-runs via npm pretest/pretest:tier2 hooks
```

The user's worktree helpers also run executables from `.wt-hooks/` (cwd = the worktree):
`create` after creation (wired: runs wt-setup, so fresh worktrees are provisioned before
any agent touches them), `done` before a worktree is marked complete, `wipe` before
unmerged deletion (`done`/`wipe` deliberately unused — nothing needs them; see
`plans/fix-worktree-engine-coupling.md` §4b).

- `node_modules` → `cp -al` hardlink-clone from the main checkout (falls back to `npm ci` if the
  lockfile differs).
- `src/engine/` → hardlinked from the newest `engine/artifacts/` snapshot (`tools/stage-engine.mjs`).
- Nothing else needed: `test/fixtures/ca` self-generates; `src/manifest.json` is committed.

## Shared vs per-checkout

| Resource | Where | Sharing |
|---|---|---|
| engine build state (`engine/WebkitWasm/{third_party,build}`, ~12 GB, gitignored) | main checkout only | singleton; resolved via git common dir (`tools/lib/paths.mjs`), build serialized by `engine/.build.lock` (flock; owner in `.build.owner`). Engine *sources* are tracked, so worktrees have copies — but never edit/build them there |
| `engine/artifacts/<stamp>/` | main checkout | immutable snapshots of `embedder.{js,wasm}` + meta.json, newest 5 kept, `latest` symlink; created by `build-engine.sh` after each build (deduped if unchanged) |
| `src/engine/` | per checkout | hardlinks into a snapshot (~0 disk; Chrome can't reliably follow symlinks, hardlinks are fine). Pruning a snapshot never breaks staged copies — hardlinks keep inodes alive |
| `node_modules` | per checkout | hardlink-clone of main's |
| test/dev-server ports | per checkout | derived block of 16 from checkout-path hash (`test/harness/ports.mjs`, base 21000–28999, override `BS_PORT_BASE`). Fixture pages that need live ports use `__HTTP_PORT__`/`__HTTPS_PORT__` placeholders substituted by server.mjs |

Port isolation matters: with a fixed port, one worktree's harness would silently talk to another
worktree's fixture server (health check passes, oracle cross-contaminates).

## JS-only work (the common case)

`wt-setup` + `npm test` / `npm run test:tier2` — no engine build involved. Concurrent worktrees
don't interact at all.

## Engine (C++) work

Engine **sources** (`engine/WebkitWasm/{src,tools,web}`) are tracked in the main repo, so every
worktree carries a copy — but builds always compile the **main checkout's** working tree (the
7.4k-object ninja graph in `build/` + `third_party/` exist only there; per-worktree builds would
cost 12 GB + a 45-min cold build each). Protocol:

1. **Edit engine sources in the main checkout's working tree only** (`/home/ai/browsception`),
   and commit them there directly. Worktree branches carry JS-side work; for coupled ABI+engine
   changes, do the engine half in the main checkout and the JS half in the worktree. WebKit-tree
   edits go in `third_party/WebKit`'s working tree.
2. `bash tools/build-engine.sh` — works from any worktree (resolves the shared tree, takes the
   lock, waits with a message if another build is running). Incremental: no-op ~1 min,
   embedder-only ~2–3 min (engine-build.md fix 6). **Guard**: run from a worktree whose tracked
   engine sources differ from main's, it aborts (your edits would be silently ignored);
   `--main-sources` overrides.
3. It snapshots to `engine/artifacts/` automatically; `node tools/stage-engine.mjs` in your
   worktree to pick it up (`--from <stamp>` to pin an older snapshot).
4. If you touched `third_party/WebKit`: build-engine.sh re-exports
   `src/patches/webkit-emscripten.patch` after each build and warns if it changed — commit the
   updated patch (it's the only tracked record of WebKit-tree edits). Leave the main checkout's
   engine/ clean-and-committed for the next claude; `engine/.build.owner` says who built last.

**Consequence**: only one line of engine work at a time. Two claudes with *divergent* engine
changes would fight over the shared working tree — don't; coordinate via the user. (If truly
parallel engine work is ever needed: symlinked `third_party/{emsdk,build-deps,wasm-sysroot}` + a
WebKit `git worktree` with the patch re-applied + its own build dir — costs a full ~45-min first
build per workspace, cheaper only with ccache set up. Not built; escalate deliberately.)

JS-side claudes are immune to concurrent engine rebuilds: staged artifacts are hardlinked
snapshots, never the live build output (a relink can rewrite output in place).
