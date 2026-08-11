# Activation, modes, and site lists

Product spec (decided 2026-08). Terminology used throughout the project:
- **sandboxed** = intercepted and run in the nested wasm engine.
- **native** = not intercepted; the top-level browser loads the site normally.

## States

```
installed ──► INACTIVE  (no interception at all; extension dormant)
                 │  toggle
                 ▼
              ACTIVE ──► whitelist mode (default)   sandbox-by-default
                    └──► blacklist mode             native-by-default
```

### Inactive
No DNR rulesets enabled, no webRequest listeners. The browser behaves as if the extension weren't
installed (aside from the toolbar icon, greyed).

### Active — whitelist mode (default)
**Everything is sandboxed except whitelisted domains.** The whitelist holds *trusted* domains the
user has decided may run natively. On install the whitelist is **empty → all websites run
sandboxed.** This is the security-first posture and the shipping default.

### Active — blacklist mode
**Everything is native except blacklisted domains.** The blacklist holds *untrusted* domains the
user wants forced into the nested browser. This is the convenience/curiosity posture (and the
posture of early development builds).

The mode determines the default disposition; the list holds the exceptions. **The two modes have
separate lists** — switching modes must never reinterpret a trusted-native list as a
sandbox-these list or vice versa. Both lists persist when switching.

## List semantics

- Entries are domains; an entry matches itself **and all subdomains** (`example.com` covers
  `www.example.com`). Registrable domain (eTLD+1) is the suggested granularity in UI; exact-host
  entries allowed for power users.
- Matching applies to **top-level (main_frame) navigations only**. Subresources are never
  independently intercepted: a sandboxed page's subresources always flow through the fetch bridge
  (they live inside the engine); a native page's subresources load natively. No mixed frames.
- Scheme scope: rules cover `http(s)` only; internal pages (`chrome://`, extension pages, etc.)
  are always native by nature.

## Cross-boundary navigation

Dispositions are evaluated per top-level navigation, so link clicks can cross the boundary:

- **Native → sandboxed**: covered automatically — the navigation hits the DNR rule and redirects
  into a viewer.
- **Sandboxed → native** (nested page navigates to a domain whose disposition is native): the
  engine's policy delegate checks top-level navigations against the current mode+list; on a
  native disposition, the viewer navigates the *real tab* to that URL, leaving the nested world.
  Without this check, whitelisted sites would get stuck rendering inside the engine.
- **One-time escape hatch** ("open this page natively, just this once"): distinct from a list
  edit. Implemented with a session-scoped, tab-scoped DNR allow rule (session rules support
  `tabIds`) so it doesn't survive the tab or edit any list.

## Toggle/edit behavior

- Mode or list changes **auto-apply to open tabs** (revised at 2.4; originally "apply on next
  reload" + a popup button — the SW's symmetric sweep is simpler and stricter): native tabs whose
  disposition became sandboxed redirect into a viewer; viewer tabs whose target became native
  leave the sandbox. The pre-sweep instant of native execution is the same known limit as the
  install race (issues/).
- Activation toggle is instant (enable/disable rulesets + the same sweep); no browser restart.

## Toolbar UI

- **Icon/badge**: greyed = inactive; colored = active; badge or icon variant distinguishes
  "this tab is sandboxed" vs "this tab is native."
- **Popup** (on the extension icon):
  - Active/inactive master switch.
  - Current tab row: disposition + primary per-site action —
    - whitelist mode, sandboxed tab: "Trust <domain> — always run natively" (adds to whitelist)
      + "Open natively once."
    - whitelist mode, native tab: "Remove <domain> from trusted list."
    - blacklist mode, native tab: "Sandbox <domain>" (adds to blacklist).
    - blacklist mode, sandboxed tab: "Remove <domain> from sandbox list."
  - Mode switch (whitelist ⇄ blacklist) behind a secondary control — mode switching is rare and
    consequential; confirm when switching *to* blacklist mode (drops the sandbox-by-default
    guarantee).
- **Options page**: full list editors for both lists (add/remove/import/export), default settings
  (private-network guard override lives here too — see networking.md).
- Security note: list edits and the escape hatch are **real browser chrome** (popup/options), which
  nested content cannot draw over or synthesize clicks into — trust decisions stay out of reach of
  sandboxed pages (see security.md). Adding to the whitelist is deliberately a two-step deliberate
  action, never a single in-viewer click.

## Storage

- Mode, activation state, and both lists in `chrome.storage.sync` (small, user-precious,
  benefits from sync across machines); mirror to `storage.local` as fallback for sync quota
  errors. List size well within sync limits for realistic use; cap UI at a few hundred entries.

## DNR implementation sketch (Chrome)

| State | Rules |
|---|---|
| Inactive | all rulesets disabled |
| Whitelist mode | static **catch-all redirect** rule (main_frame, http(s) → `viewer.html?url=\0`, low priority) enabled + one dynamic **`allow`** rule per whitelisted domain (`requestDomains`, higher priority) |
| Blacklist mode | catch-all ruleset disabled; one dynamic **redirect** rule per blacklisted domain |
| Escape hatch | session rule: `allow`, `tabIds: [tab]`, highest priority |

- `allow` beats `redirect` at higher priority; dynamic-rule quota (tens of thousands in MV3) is
  far above any realistic list size.
- Keep the catch-all in a **static** ruleset toggled via `updateEnabledRulesets` so whitelist-mode
  interception works even if the SW is cold; dynamic rules persist across SW restarts too.
- Firefox (later): same semantics implemented in the blocking `onBeforeRequest` listener — an
  in-listener decision function replaces the rule table (simpler, since it's imperative).

## Shipping default (landed 2.6, 2026-08-10)

Whitelist mode is the default: `DEFAULT_STATE` in src/ext/state.mjs is
`{active: true, mode: 'whitelist'}` with empty lists, and the static catch-all ships **enabled in
the manifest** (tools/gen-ext.mjs) so a fresh install intercepts before the SW ever runs — the two
must stay in agreement. The SW disables the catch-all for blacklist/inactive states and that
toggle persists. Test suites that need native fixture traffic pin their own posture explicitly
(tier-1 bridge suite: blacklist+empty; tier-2: fixture-domain blacklist).
