# Release builds

`npm run release [chrome|firefox]` (`scripts/release.mjs`) turns a fresh clone into installable
packages. It is an orchestrator only — every step is a call into the script that already owns
that step, and each of those has its own "already done" fast path, so a re-run after a JS-only
change is ~7 s and never rebuilds the engine:

| Step | Script | Fast path |
|---|---|---|
| engine | `scripts/build-engine.sh` | exits early when a snapshot's `source_hash` matches this checkout (`--skip-engine` skips even that; the check takes the build lock but never the WebKit tree) |
| deps | `scripts/wt-setup.mjs --quiet` | `npm ci` only when `node_modules` is absent |
| stage | `scripts/stage-engine.mjs` | hardlinks; **unpins** an A/B pin on purpose — a release ships the engine built from these sources |
| manifest | `scripts/gen-ext.mjs` | chrome only (`src/manifest.json`) |
| pack | `scripts/pack-ext.mjs` | re-links only what changed |
| zip | `scripts/lib/zip.mjs` | — |

Outputs: `dist/<target>/` (loadable unpacked) and `dist/browsception-<version>-chrome.zip` /
`-firefox.xpi`.

## Versioning

One number, `VERSION` in `scripts/lib/manifest.mjs`, plain integers (v1, v2, …): nothing has a
stable API, and manifests only need 1–4 dot-separated integers that increase. package.json is
`private` with no version field so nothing can drift. Cutting a release: bump `VERSION`,
commit, `git tag v<N>`, `npm run release`, attach `dist/*.zip` + `*.xpi` to a GitHub release
on that tag. release.mjs prints the version + short SHA and **warns** (start and end, never
fails) when the tree has uncommitted tracked changes or HEAD isn't tagged `v<VERSION>` — the
archives are byte-reproducible, so a tagged clean build is what makes an asset verifiable.

## Packaging

`scripts/pack-ext.mjs <target>` assembles `dist/<target>/` as hardlinks into `src/` (the 100 MB
engine costs nothing) minus what the other browser owns, plus that browser's manifest:

- **chrome** — `src/manifest.json` verbatim (gen-ext owns it), minus `ext/background.html`.
  Chrome also loads `src/` directly; the dist tree exists so the package excludes `_metadata/`,
  which Chrome itself writes into an unpacked root.
- **firefox** — manifest from `scripts/lib/manifest.mjs`. This is what the tier-2 Firefox harness
  installs.

Neither package pins an extension id: no `key`, no static rulesets, nothing that bakes an
absolute `chrome-extension://…` URL. Every DNR rule is installed at runtime, so a store-assigned
id works unchanged (notes/distribution.md).

`scripts/lib/zip.mjs` is a ~90-line zip writer (no npm dep, no `zip` binary): sorted entries,
fixed 1980 timestamps and permissions, so identical inputs give a byte-identical archive —
verified identical across two checkouts. Plain zip32; our largest member is the 100 MB wasm,
nowhere near the 4 GB zip64 line.

Not run by release: tests. A release build is a build, not a gate.
