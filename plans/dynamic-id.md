# Plan: dynamic extension id (drop the pinned key + static catch-all)

## Why

The Chrome manifest pins a `key` (the dev probe key in `test/fixtures/probe-ext/key.b64`) only
so that the **static** catch-all ruleset can bake an absolute redirect URL
(`chrome-extension://niccek…/ext/viewer.html?url=\0`) at build time. That pin is the one thing
standing between `dist/` and any distribution channel: the Chrome Web Store assigns its own key
on first upload, and a store install with a different id would redirect every navigation into
a dead URL. Firefox already runs the catch-all as a **dynamic** rule (per-profile UUID) and
works. Make Chrome do the same, delete the key, and both manifests become id-agnostic.

Cost: a fresh install intercepts only once the service worker's first run has installed the
dynamic rule (`onInstalled` → one `updateDynamicRules`, milliseconds, no navigation in flight
at install). Every later browser start already carries the startup race (security.md) whether
the rule is static or dynamic, so the exposure model does not change. Dynamic rules persist
across restarts and extension updates on both browsers.

Bonus: the reconcile becomes **one atomic call** (no static toggle + dynamic swap pair), so the
"reconcile gap must never intercept less" ordering logic (`applyPlan`) and its test go away.

## Steps

1. **`src/ext/dnr-rules.mjs`** — the catch-all is always dynamic. Remove the `staticCatchall`
   option, `enabledStaticRulesets`, `applyPlan`, `CATCHALL_RULESET_ID`; keep `CATCHALL_RULE_ID`
   and `catchallRules(viewerBase)`. Rewrite the header comment above `catchallRules` (it
   explains the pinned key). `desiredRuleState` returns `{dynamicRules, sessionRules}`.
2. **`src/ext/sw.mjs`** — drop `STATIC_CATCHALL` and the `getEnabledRulesets` /
   `updateEnabledRulesets` calls; the reconcile is `getDynamicRules` + one `updateDynamicRules`.
   Keep `onInstalled`, `onStartup` and the top-level `applyState()` (that top-level call is what
   re-installs the rule after an update that changes rule shape). Fix the file header ("static
   ruleset toggle + dynamic rules").
3. **`scripts/lib/manifest.mjs`** — `chromeManifest()` takes no key; remove `key` and
   `declarative_net_request.rule_resources`. Keep COOP/COEP and `minimum_chrome_version`. Update
   the header comment. Chrome and Firefox now differ only in `background` and
   `browser_specific_settings`.
4. **`scripts/gen-ext.mjs`** — writes `src/manifest.json` only (no key read, no id derivation,
   no `src/rules/`). `git rm src/rules/catchall.json`; `.gitignore` unchanged.
   **`scripts/pack-ext.mjs`** — remove `rules` from the firefox exclusion set and the
   static-ruleset comments. `scripts/release.mjs` step list unchanged.
5. **Test harness** — `extensionIdFromManifest` cannot work without a key. Add
   `extensionId(context)` to `test/harness/launch.mjs`: read the id from the extension service
   worker's URL (`context.serviceWorkers()`, else `context.waitForEvent('serviceworker')`),
   `chrome-extension://<id>/ext/sw.mjs`. Unpacked ids are a hash of the load path, so each
   worktree gets its own; nothing may hard-code one. Keep `extensionIdFromManifest` for the
   probe extension only (it keeps its key and static rulesets: the tier-1 interception suite
   deliberately tests static rules with the SW killed, a platform property, not our design).
6. **Tests**
   - `test/tier0/dnr-rules.test.mjs`: delete the static-vs-dynamic and `applyPlan` tests; assert
     whitelist mode's dynamic set starts with `catchallRules(VIEWER)[0]` and that
     `PRIORITY.ALLOW > PRIORITY.CATCHALL` still holds; blacklist mode has no catch-all rule.
   - `test/tier1/bridge.test.mjs:39` and `sweep.test.mjs`: id via `extensionId(context)`; the
     "catch-all not enabled" wait becomes "no dynamic rule with id 1".
   - `test/tier2/scenarios.test.mjs`: `EXT_ID` via the harness helper (it is computed at module
     top level today; move it after `launch`). The `test.before` fresh-install probe must wait
     for the dynamic catch-all (`getDynamicRules` has id 1) before navigating, as
     `firefox.test.mjs` does; the "default posture" scenario still asserts on a navigation made
     before any storage write. The boundary scenario's two `getEnabledRulesets` waits become
     dynamic-rule checks. Fix the comments at ~61 and ~603.
   - `test/tier2/firefox.test.mjs`: comments only ("Firefox cannot ship a static one" is no
     longer the reason; both browsers are dynamic).
7. **Notes** — ui.md § DNR table + § shipping default; security.md § startup race (add the
   install-time window sentence) and § "reconcile's own gap" (now a single atomic call, section
   shrinks to one paragraph); extension-platform.md § Firefox bullet and the "Keep DNR rules
   static" limits bullet; testing.md fixture paragraph (gen-ext no longer reads the probe key);
   release.md § packaging (no key ships, no `src/rules/`); distribution.md § extension id;
   experiment-log.md dated entry. Delete this plan.
8. **Verify** — `npm test`; `npm run test:tier2` and `test:tier2:firefox`; then
   `npm run release`, load `dist/chrome/` unpacked in a throwaway profile (gui-testing skill), and
   confirm: id differs from `niccek…`, a fresh-profile navigation lands in the viewer, the
   badge shows, and after a Chrome restart the rule is still present (`getDynamicRules` from the
   SW console).

## Not in scope

Store submission itself, icons, version unification — see notes/distribution.md.
