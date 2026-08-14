# Repo hygiene: binaryen via npm, engine-pre.js relocation, retire spikes/ + experiments/

Goal: one convention per kind of thing. JS deps come from npm + lockfile; engine build inputs
live under `engine/WebkitWasm/src/`; test fixtures live under `test/fixtures/`; durable records
live in `notes/`. Steps are independent — land in order, verify each.

## 1. binaryen.js → exact-pinned npm devDependency

Resolves `issues/vendored-web-dep-hygiene.md` (delete the issue when done).

- Add `"binaryen": "130.0.0"` (exact, no `^`) to root package.json devDependencies; `npm install`
  updates the lockfile. npm package verified: v130.0.0 exists, ESM (`type: module`, main
  `index.js`) — same major as the vendored blob, so browser.html's v130-specific workarounds
  (multi-table FATAL, bulk-memory abort, memory-packing breakage) still apply. Keep those
  comments next to the import as the reason the pin is exact.
- Serve from node_modules: bake a built-in `/vendor` mount into
  `engine/WebkitWasm/tools/dev-server.mjs` (→ repo-root `node_modules`, only if it exists) rather
  than repeating `--mount` flags at every call site (smoke-browse.mjs, smoke-leak.mjs, README
  instructions). The mount machinery already exists.
- browser.html: `import("./vendor/binaryen.js")` → `import("/vendor/binaryen/index.js")`.
- Delete `engine/WebkitWasm/web/vendor/`. (Blob stays in git history — accepted, no rewrite.)
- LICENSING.md: add a binaryen row to the third-party table (Apache-2.0, fetched via npm, dev
  harness only). With the blob gone, the "fetched, not redistributed by us" framing is accurate
  again.
- Worktrees need no work: wt-setup already hardlink-clones node_modules on lockfile match.
- Verify: dev server serves `/vendor/binaryen/index.js`; the browser.html wasm shim loads a
  guest-wasm page (tier-2 wasm scenario / manual harness check).

## 2. engine-pre.js → src/embedder/

It's a build input (`--pre-js`, compiled into the embedder), not harness JS — the only file that
makes `web/` ≠ "harness-only" and forces special-casing in two tools.

- `git mv engine/WebkitWasm/web/engine-pre.js engine/WebkitWasm/src/embedder/engine-pre.js`.
- Update path + comments: `src/embedder/embedder.cmake` (`--pre-js` line and nearby comments),
  `tools/build-engine.sh` (header comment + `PRE_STAMP`/`PRE_NOW` paths),
  `tools/lib/engine-src-hash.mjs` (drop the special-case — a plain walk of `src/` now covers it),
  `engine/WebkitWasm/tools/build-webcore.sh` header comment.
- Grep for remaining `web/engine-pre` references in notes/ (engine-build.md, worktrees.md) and fix.
- Verify: `tools/build-engine.sh` does an incremental relink and the src-hash changes when
  engine-pre.js is touched; restage + `npm run test:tier2`.

## 3. probe-ext → test/fixtures/probe-ext/

Not dead: three tier-1 suites load it as their fixture extension, and gen-ext.mjs reads the
pinned extension key from it. It's a test fixture, so move it where fixtures live.

- `git mv spikes/probe-ext test/fixtures/probe-ext` (key.b64 is tracked; key.pem/_metadata are
  gitignored and regenerate/carry over untracked).
- Update paths: `PROBE_EXT` in test/tier1/{interception,bridge-probe,parity}.test.mjs,
  `tools/gen-ext.mjs` key path, `notes/bridge-probe.md` environment line.
- Verify: `npm test`; `node tools/gen-ext.mjs` produces an unchanged src/manifest.json (same
  pinned id).

## 4. Delete spikes/blit/

Results are already distilled (open-questions #10 answer; blit.mjs graduated from it).

- Fold any still-useful numbers from `spikes/blit/RESULTS.md` into the open-questions #10 answer,
  then delete the directory.
- Update references: notes/open-questions.md ("details in spikes/blit/RESULTS.md", "viewer
  skeleton in spikes/blit/"), the header comment in src/ext/blit.mjs.
- `spikes/` is now empty — remove it.

## 5. Retire experiments/

- `git mv experiments/log.md notes/experiment-log.md` — it's the durable lab notebook (notes
  README cites it for both exit gates); keep it, don't delete. Add it to the notes/README.md
  index and fix the two exit-gate references. Fix its internal `spikes/probe-ext` /
  `spikes/blit` mentions to note the moves (it's a historical record — a one-line "paths since
  moved" note beats rewriting entries).
- Move the two still-useful probes to tools/: `experiments/perf-scroll-probe.mjs` and
  `experiments/scroll-roundtrip.mjs` → `tools/`. Update their usage comments and the references
  in notes/rendering-input.md § scrolling.
- notes/testing.md lab-notebook section: log now lives at `notes/experiment-log.md`; perf data
  convention changes from `experiments/data/` to session scratchpad (copy numbers into the log
  entry — the log is the record, raw dumps are transient).
- .gitignore: drop the `experiments/data/` line.
- `experiments/` is now empty — remove it.

## Wrap-up

- Delete `issues/vendored-web-dep-hygiene.md`.
- Delete this plan; fold anything durable (the "web/ is harness-only" and "fixtures under
  test/fixtures/" invariants) into notes (engine-build.md / testing.md).
- Full verify: `npm test`, `npm run test:tier2`, one smoke-browse pass.
