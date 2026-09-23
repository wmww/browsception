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
`private` with no version field so nothing can drift. release.mjs prints the version + short
SHA and **warns** (start and end, never fails) when the tree has uncommitted tracked changes or
HEAD isn't tagged `v<VERSION>` — the archives are byte-reproducible, so a tagged clean build is
what makes an asset verifiable. Reproducible across hosts and checkout paths too (the AMO
reviewer rebuild; distribution.md § Channel 3): `Dockerfile` + `scripts/build-from-source.sh`
are the reference environment.

## Cutting a release

See [releasing.md](releasing.md) — the step-by-step checklist for "make a release".
