# First navigation can race DNR ruleset registration (fresh profile / install)

Observed 2026-08-09 during the guibox recipe check (spike 0.5): launching Chromium with a
fresh profile, `--load-extension`, and a startup URL on a blacklisted domain loaded the
site **natively**; a reload was then intercepted normally. The very first navigation beat
static ruleset registration, violating the no-target-bytes invariant once.

Impact:
- Real users: the tab(s) open at install time, and possibly the first navigation right
  after install, run native even when they should be sandboxed. Whitelist mode's
  "sandbox by default from install" promise has a one-shot hole.
- Dev/test flows: any harness that passes the target URL on the command line tests the
  native path by accident (tier-1 tests dodge this because they navigate after startup).

Ideas (untested):
- `chrome.runtime.onInstalled`/startup: sweep existing tabs (`tabs.query`) and redirect
  any whose URL should be sandboxed to the viewer (`tabs.update`). Doesn't un-execute the
  page but closes the window quickly. (Target page JS has already run by then — document.)
- Check whether packed/store installs (vs `--load-extension`) have the same window.
- Tier-1 regression test: launch with a startup URL and assert post-sweep state once a
  sweep exists.
