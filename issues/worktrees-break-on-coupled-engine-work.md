# The worktree workflow has no story for coupled engine+JS changes

Hit while executing `plans/remove-wisp-curl.md` (2026-08-13), which touched
`engine/WebkitWasm/{src,web,tools}` **and** `src/ext/`, `test/`, `tools/`, `notes/` as one
logical change. The worktree it was started in (`wt_gL97qZLkaIZQrJer`) ended up completely
unused: every edit had to be made in the main checkout and the worktree's branch is empty.

notes/worktrees.md says "worktree branches carry JS-side work; for coupled ABI+engine
changes, do the engine half in the main checkout and the JS half in the worktree." That
splits one reviewable change across two branches with a build dependency between them, and
the JS half can't even be tested until the engine half is committed and built elsewhere. In
practice the only workable move is what happened here — do all of it in main, leave the
worktree idle.

## Concrete breakages

1. **No single branch can hold the change.** `tools/build-engine.sh` diffs the worktree's
   `engine/WebkitWasm/{src,tools,web}` against main's and aborts on any difference (correctly
   — it compiles main's sources). So engine edits must be made *and committed* in main. Any
   coupled JS change then either lives on a different branch or also goes in main.

2. **`.worktrees/` is not gitignored.** It shows as `?? .worktrees/` in every `git status` in
   the main checkout, and a `git add -A` there would commit an entire nested checkout.
   (Fixed in the same commit as this issue — one `.gitignore` line. The rest below is not.)

3. **`stage-engine.mjs` will happily stage a mismatched artifact.** It takes
   `engine/artifacts/latest` unconditionally. After engine work lands in main, a stale
   worktree hardlinks an artifact built from *main's new* sources next to its own *old*
   tracked engine sources and JS. Verified after this cut:

   ```
   $ diff -rq .worktrees/wt_.../engine/WebkitWasm/src engine/WebkitWasm/src
   Files .../BibWebSocketChannel.h and .../BibWebSocketChannel.h differ
   ... (8 files)
   ```

   Tier-2 there would run new engine against old shim with no warning. Each snapshot's
   `meta.json` already records `engine_sha` + `engine_dirty`, so the data to detect this
   exists; nothing checks it.

**Plan**: `plans/fix-worktree-engine-coupling.md` (2026-08-13) — build the invoking
checkout's sources against the shared tree; supersedes the options below.

## Possible fixes (unranked, none attempted)

- `stage-engine.mjs`: compare the snapshot's `engine_sha`/tracked-source hash against the
  current checkout and warn (or refuse without `--force`). Cheapest real win — turns a silent
  mismatch into a message.
- Let `build-engine.sh` build *the current worktree's* engine sources into the shared build
  dir, serialized by the existing `engine/.build.lock`, instead of refusing. The lock already
  makes builds mutually exclusive; the objection in worktrees.md is that two claudes with
  divergent engine changes would thrash the ninja graph — but that's a cache-miss cost, not a
  correctness problem, and it makes one-branch coupled work possible.
- Or state plainly in worktrees.md that coupled engine+JS work is main-checkout-only and the
  wrapper should not hand such a task to a worktree in the first place.

Standing constraint either way: only one line of engine work at a time (shared 12 GB tree).
