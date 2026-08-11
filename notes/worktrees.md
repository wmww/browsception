# Ephemeral worktrees

The user's scripts create/merge worktrees under `.worktrees/wt_*`; multiple claudes may work in
parallel worktrees. Everything below makes that cheap: **never** build the engine from scratch in a
worktree, and never copy the 12 GB `engine/` tree.

## Setup (once per fresh worktree, idempotent, ~2 s)

```sh
node tools/wt-setup.mjs     # also auto-runs via npm pretest/pretest:tier2 hooks
```

- `node_modules` → `cp -al` hardlink-clone from the main checkout (falls back to `npm ci` if the
  lockfile differs).
- `src/engine/` → hardlinked from the newest `engine/artifacts/` snapshot (`tools/stage-engine.mjs`).
- Nothing else needed: `test/fixtures/ca` self-generates; `src/manifest.json` is committed.

## Shared vs per-checkout

| Resource | Where | Sharing |
|---|---|---|
| `engine/` (12 GB WebkitWasm tree) | main checkout only | singleton; resolved via git common dir (`tools/lib/paths.mjs`), build serialized by `engine/.build.lock` (flock; owner in `.build.owner`) |
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

The engine tree is a **shared singleton** (sources + 7.4k-object ninja graph; per-worktree copies
would cost 12 GB + a 45-min cold build each, ext4 has no reflinks, and there's no ccache). Protocol:

1. Edit sources in `/home/ai/browsception/engine/WebkitWasm` (branch `browsception`); WebKit-tree
   edits go in its `third_party/WebKit` working tree.
2. `bash tools/build-engine.sh` — works from any worktree (resolves the shared tree, takes the
   lock, waits with a message if another build is running). Incremental: no-op ~1 min,
   embedder-only ~2–3 min (engine-build.md fix 6).
3. It snapshots to `engine/artifacts/` automatically; `node tools/stage-engine.mjs` in your
   worktree to pick it up (`--from <stamp>` to pin an older snapshot).
4. Before ending an engine session: `tools/export-webkit-patches.sh` (in WebkitWasm) if you touched
   the WebKit tree, and commit the WebkitWasm branch — leave the shared tree clean for the next
   claude. `engine/.build.owner` says who built last.

**Consequence**: only one line of engine work at a time. Two claudes with *divergent* engine
changes would fight over the shared working tree/branch — don't; coordinate via the user. (If truly
parallel engine work is ever needed: WebkitWasm `git worktree` + symlinked
`third_party/{emsdk,build-deps,wasm-sysroot}` + a WebKit `git worktree` with the patch re-applied +
its own build dir — costs a full ~45-min first build per workspace, cheaper only with ccache set
up. Not built; escalate deliberately.)

JS-side claudes are immune to concurrent engine rebuilds: staged artifacts are hardlinked
snapshots, never the live build output (a relink can rewrite output in place).
