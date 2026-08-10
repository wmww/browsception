# First navigation can race DNR ruleset registration (fresh profile / install)

Observed 2026-08-09 (spike 0.5): a startup URL on a blacklisted domain loaded natively once;
the first navigation beat static ruleset registration.

**Mitigated 2026-08-10 (2.2):** the SW sweeps open tabs on install/startup/state-change and
redirects any that should be sandboxed (`sw.mjs sweep()`; tier-2 "sweep" scenario covers the
mechanism). The residual window is inherent: target-page JS runs for the moment before the
sweep lands — the sweep closes the exposure, it cannot un-execute. Document as a known limit
in security.md when 2.5's invariant audit lands.

Remaining to check:
- Does a packed/store install (vs `--load-extension`) have the same window at all?
- Install-time specifically: onInstalled fires before or after pre-existing tabs finish
  loading? (Sweep handles either, but worth knowing the real ordering once.)
