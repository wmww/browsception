# A staged engine artifact carries no identity, so I measured a neighbour's build as my own

**Hit** 2026-08-14 by the agent in `wt_tA1vg04oitt43jWG` while A/B-measuring the scroll-input fix.
Caught by disbelief at the numbers, not by anything the tooling said. Nothing was corrupted and no
wrong conclusion shipped, but the failure is silent by construction and the next one may not be
caught: **an A/B comparison ran the wrong engine on one side and produced a coherent, plausible,
completely wrong result.**

## What happened

1. 07:33:50 — main checkout builds HEAD → `20260814-073350-02932cf` (`source_hash 3e8a4814…`).
   This is the "before" artifact I needed.
2. 07:46:54 — I build my branch → `20260814-074654-02932cf-dirty` (`source_hash da035cba…`,
   checkout `…/wt_tA1vg04oitt43jWG`). `node tools/stage-engine.mjs` (no args) stages it correctly
   by source-hash match. First measurements look right.
3. 07:48:38 — worktree `wt_5DfFXrk0Sgu6MVJw` (another agent, working in parallel) finishes its own
   build → `20260814-074838-02932cf-dirty` (`source_hash 2cecb3c9…`, and a *different*
   `webkit_patch` — it took the WebKit tree over from me between the two builds).
4. I need to alternate artifacts for a clean A/B, so I switch to explicit pinning:
   `ls engine/artifacts/ | tail -5` →

   ```
   20260814-071134-1a84795
   20260814-073350-02932cf
   20260814-074654-02932cf-dirty
   20260814-074838-02932cf-dirty      <- the neighbour's, indistinguishable
   latest
   ```

   Both worktrees sit on sha `02932cf` with dirty engine sources, so **both stamps are
   `<time>-02932cf-dirty`**. I took the newest one as "the build I just made" — it was 1m44s
   newer than mine and I had just built. Wrong one.
5. Four probe runs (~8 min) later, the "NEW" rows were indistinguishable from "OLD":
   `engBlitWriteMs` still ~150-200 ms/s, `engWheelN` still 61/s (= the host event rate, i.e. no
   coalescing at all). Both effects are structurally impossible in my build, so I opened the three
   `meta.json` files and found `"checkout": "…/wt_5DfFXrk0Sgu6MVJw"`. Redoing the A/B with
   `--from 20260814-074654-02932cf-dirty` gave the real numbers.

## Why it was possible

Each of these is defensible alone; together they make artifact identity invisible exactly where it
matters.

- **Stamps are not unique per checkout.** `<time>-<sha>[-dirty]` collides whenever two worktrees
  build the same commit, which is the *normal* state when several agents branch off `main` — and
  `-dirty` guarantees the sources differ while the name says they don't. The only distinguishing
  fields (`checkout`, `branch`, `source_hash`, `webkit_patch`) live inside `meta.json`, which
  nothing prints and nothing checks on the path I was using.
- **`--from` is documented as "pins, no checks" and means it.** It stages any stamp from any
  checkout, silently. The default (hash-matching) path has a genuinely good warning naming the
  artifact's checkout/branch/sha/source_hash when it has to fall back to `latest` — `--from` never
  reaches it. The safe path is the one that warns; the deliberate path is the one that doesn't.
- **The staging log line names only the stamp**: `staged embedder.wasm (99.3 MB, link from
  20260814-074838-02932cf-dirty)`. That string is exactly what I misread in the first place, so it
  confirmed my mistake back to me.
- **No measurement output records which engine ran.** `launch({needsEngine: true})` →
  `requireStagedEngine()` only checks that `src/engine/embedder.wasm` *exists*. Probe output starts
  at `fb = {...}`. A saved probe log therefore cannot be attributed to a build after the fact —
  including the logs I pasted into notes.
- **`--from` pinning is not stable.** Any `npm test` / `npm run test:tier2` / dev-harness start in
  the same checkout runs `stage-engine --if-stale`, which re-selects by source-hash and silently
  replaces the pinned artifact. Interleaving a test run with an A/B sweep would swap the engine
  mid-experiment.
- **Concurrency is invisible to the measurer.** `engine/.build.owner` knew a neighbour had the
  build lock at 07:46:54; I only looked after the fact. That also matters for the numbers
  themselves: my two "old" rounds differed by 13 fps (58.6 @ 49% busy vs 45.1 @ 85%), plausibly
  their ninja + browser load, while the new-engine rounds repeated within 0.5 fps.

## Why I did what I did

- **Pinned with `--from` at all**: an A/B needs an artifact that deliberately does *not* match the
  current checkout's sources, so the hash-matching default cannot express it. `--from` is what
  notes/worktrees.md documents for this ("`--from <stamp>` pins explicitly").
- **Picked by recency**: with the stamp as the only visible identity and my build being the most
  recent thing I had done, "newest `-dirty` at my sha" looked like an identifying description. It
  is not one.
- **Believed the result was wrong before I knew why**: I had a same-session measurement of my own
  build minutes earlier, so a "NEW" run with the old cost profile was impossible rather than
  merely disappointing. Without that prior — e.g. if the mix-up had happened on the *first*
  measurement of a change — the numbers would have read as "the fix does nothing", and the honest
  next step would have been to go rewrite working code.
- **Re-ran interleaved (OLD, NEW, OLD, NEW)** rather than one block each: with a neighbour
  competing for CPU, drift shows up as within-pair spread instead of a systematic bias.
- **Recorded the trap in notes/experiment-log.md** with the corrective ritual (pin by explicit
  stamp; check `src/engine/.staged-meta.json` afterwards). That is a habit, not a fix — it only
  helps agents who already read that entry.

## Suggested fixes (owner's call)

Cheap and directly aimed at what failed:

1. **Print provenance whenever anything is staged**, `--from` included: stamp + branch + checkout
   basename + `source_hash`. One line, and the mistake announces itself.
2. **Make `--from` warn when the snapshot's `checkout` is not this checkout** (still allowed — that
   is the A/B use case — but named out loud, e.g. `pinning wt_5DfFXrk0Sgu6MVJw's artifact`).
3. **Put the owner in the stamp**: `<time>-<sha>[-dirty]-<checkout-token>`. `ls artifacts/` becomes
   self-explanatory and `--from` typos stop being plausible.
4. **`stage-engine --list`**: stamp, branch, dirty, `source_hash`, `webkit_patch`, staged-or-not.
   Removes the `cat meta.json` spelunking that eventually solved this.
5. **Have engine-backed probes/tests print the staged stamp + `source_hash` at startup** (the data
   is already in `src/engine/.staged-meta.json`). Then every measurement log is self-attributing,
   which is what makes an A/B checkable by someone other than its author.

Worth considering, less certain:

6. **Warn when another checkout holds/held the build lock during a measurement run** — concurrent
   builds invalidate timing numbers even when the right artifact is staged.
7. **Make a pin sticky** (e.g. `.staged-meta.json` records `pinned: true`, honoured by
   `--if-stale`), or at least have `--if-stale` say out loud when it replaces a pinned artifact.
8. **`--from mine` / `--from head`** sugar, so the common intents never need a stamp typed by hand.

## Not the problem

- `tools/stage-engine.mjs`'s default path is fine: it matched my sources correctly every time, and
  its `latest` fallback warning is the model the rest should follow.
- Nothing raced or corrupted: hardlinked snapshots, the build lock, and the WebKit-tree takeover
  all did their jobs. The neighbour's build was legitimate and lossless. The gap is purely in
  **naming and reporting**, not in the concurrency machinery.
