# Making a release

The checklist for "make a release". Every step says what to run and what the result should
look like. If a check comes out differently, **stop and ask** — never publish around a
surprise. Being asked for a release is the approval to push and to create the GitHub release,
nothing more (no force-pushes, no deleting other people's tags, no store submissions).

Releases are plain integers (v1, v2, …), see release.md § Versioning. Packaging internals are
in release.md; the install paths users follow are README § Install.

## 1. State

```sh
git status --short            # empty
git rev-parse --abbrev-ref HEAD   # main
git fetch origin && git status -sb | head -1   # not behind origin/main
gh auth status                # logged in
ls /usr/bin/firefox           # exists (or $BS_FIREFOX) — the Firefox tests skip without it
```

Not clean, not on main, or behind origin: ask. Uncommitted work is not yours to decide about,
and "pull" needs its own approval (CLAUDE.md).

## 2. Version and scope

```sh
git tag -l 'v*' | sort -V | tail -1     # last tag, v<prev>
gh release list --limit 3               # agrees with the tags
git log --oneline v<prev>..HEAD         # what's going in (first release: whole history)
```

New version is `<prev> + 1`. Read the log and `git diff --stat v<prev>..HEAD`; you will need
it for the notes, and it tells you whether anything under `engine/`, `src/shim/` or `src/abi/`
changed — i.e. whether step 4 will actually recompile (~1.5 h) or no-op in seconds.

If the tag list and GitHub's release list disagree, or a `v<N>` tag already exists for the
version you're about to cut, ask.

## 3. Tests — both browsers, all tiers

```sh
npm test                      # tiers 0-1, headless, ~20 s
npm run test:tier2            # Chrome scenarios + Firefox subset against the staged engine
```

Read the summary lines of each: `fail 0` **and** `skipped 0`. A skip means a suite didn't
run (Firefox missing, engine not staged) and counts as a failure for release purposes.

On a failure: a known-flaky scenario (check `issues/`) may be rerun once; if it passes, note
the flake in its issue and continue. Anything else: stop, report the output, do not release.
No flag skips tests and none should be added.

Tier 2 needs the engine staged (`src/engine/`); if it isn't, run step 4's build first and
come back.

## 4. Bump and build

1. Set `VERSION` in `scripts/lib/manifest.mjs` to `<N>` (already `<N>`: nothing to bump, not a surprise).
2. If a fact in README (status, install steps) or notes/distribution.md changed with this
   release, update it now — those edits ship with the release commit.
3. Commit: `release: v<N>`.
4. Build:

```sh
npm run release               # both browsers; ~1.5 h if the engine has never been built here
```

Expect: `browsception v<N> (<sha>)` at the top, one warning (`HEAD is not tagged v<N>`, that
comes next), **no** dirty-tree warning, and after the stage step

```
engine sources <hash> are committed and match the staged artifact
```

then `dist/browsception-<N>-chrome.zip` and `-firefox.xpi` at the end, each ~34 MB.

That one line is the whole engine-provenance check; if it is missing, the build says why in a
warning instead — stop and ask. **Ignore the snapshot's stamp** (`…-<sha>-dirty-<checkout>`):
it names the *first* build that produced those bytes, so a stamp can read `-dirty`, or carry
another branch or checkout, while the artifact is an exact match for this commit — identical
sources dedupe onto the existing snapshot and only add a hash to it. Reading a stamp as
provenance stalled the v1 release (2026-09-09); the hash line exists so that cannot recur, and
nothing here is worth a 1.5 h WebKit rebuild that would emit the same bytes.

If step 3 ran before the bump commit (normal), that's fine: tests cover code, not the version
string. If anything other than `VERSION` and docs changed since the tests ran, rerun step 3.

## 5. Release notes

Write them to a scratch file, for someone *using* the extension: what's new, what's fixed,
what's known-broken (skim `issues/`), in a few short bullets. Not the commit list — that goes
in a collapsed block below. Until the project stops being rough, say so. Then append:

```markdown
**Install:** see [Installing a release](https://github.com/wmww/browsception#installing-a-release)
(Chrome: unzip + load unpacked; Firefox: temporary add-on, or Developer Edition/Nightly with signing off).

<details><summary>Commits since v<prev></summary>

<output of: git log --no-merges --format='- %s' v<prev>..HEAD>

</details>
```

(Omit the details block on the first release.)

## 6. Tag, push, publish

```sh
git tag -a v<N> -m v<N>
git push origin main
git push origin v<N>
gh release create v<N> dist/browsception-<N>-chrome.zip dist/browsception-<N>-firefox.xpi \
  --title v<N> --notes-file <scratch notes> --verify-tag
gh release view v<N>          # both assets listed, sizes ~34 MB, notes rendered
```

Run the pushes in the foreground with a generous timeout: they can stall on an ssh/gh auth
prompt. A stall or rejection (non-fast-forward, auth) is a stop-and-ask, not a retry loop.
If the upload fails after the tag is pushed, `gh release upload v<N> <asset> --clobber` or
`gh release create` again — the tag and commit are already right.

## 7. Report

Give the user the release URL, the version, the test tallies, and anything you noticed
(flake reruns, doc updates you made). Then add a dated line to notes/README.md § Status if
the release is a milestone worth recording there.

## Redo / rollback

Only when the user asks. A release that is wrong shortly after publishing:

```sh
gh release delete v<N> --cleanup-tag --yes    # removes the GitHub release and the remote tag
git tag -d v<N>                               # local tag
```

Then fix, and cut the *same* number again only if nobody can have installed it; otherwise
bump to `<N+1>`. Never move a tag someone may have fetched.
