// Background service worker (2.2): owns activation/mode/list state
// (storage.sync) and applies it declaratively to DNR. Interception itself
// never depends on this worker being awake — the rules persist (static
// ruleset toggle + dynamic rules); the SW only reconciles state changes.
//
// Also sweeps open tabs whose disposition no longer matches state: it applies
// list edits to open tabs, and — the security-critical part — it is the ONLY
// backstop for a navigation the rules never saw, which EVERY browser start
// with a startup/handoff URL produces (notes/security.md § Startup race). By
// sweep time the page's JS has run: the redirect closes the exposure window,
// it cannot un-execute anything.

import {
  desiredRuleState,
  sweepAction,
  tabUrl,
  viewerTarget,
  escapeSessionRule,
  escapeRuleId,
  CATCHALL_RULESET_ID,
} from './dnr-rules.mjs';
import { normalizeEntry } from './list-match.mjs';
import { getState } from './state.mjs';

const VIEWER = chrome.runtime.getURL('ext/viewer.html');

// Serialized apply: a burst of storage changes must not interleave DNR calls.
let applying = Promise.resolve();
function applyState() {
  applying = applying.then(doApply, doApply);
  return applying;
}

async function doApply() {
  const state = await getState();
  const desired = desiredRuleState(state, VIEWER);

  const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
  const wantCatchall = desired.enabledStaticRulesets.includes(CATCHALL_RULESET_ID);
  if (wantCatchall !== enabled.includes(CATCHALL_RULESET_ID))
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      wantCatchall
        ? { enableRulesetIds: [CATCHALL_RULESET_ID] }
        : { disableRulesetIds: [CATCHALL_RULESET_ID] },
    );

  // Dynamic rules replaced wholesale (one atomic update). Session rules are
  // NOT touched here: the bridge's header rules and (2.3) escape hatches live
  // there, each managing its own id namespace.
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: desired.dynamicRules,
  });

  // Only now: un-sandboxing a tab before its allow rule exists would just
  // bounce off the catch-all back into the viewer. (Sweeping the sandbox
  // direction earlier was tried and measured — no effect on the exposure
  // window, which is SW-startup-bound.)
  await sweep(state, await escapeGrants());
  await refreshBadges(state);
}

// SYMMETRIC sweep (ui.md § toggle/edit behavior): state changes apply to
// open tabs in both directions — native tabs that should now be sandboxed
// redirect into a viewer, and viewer tabs whose target is now native leave
// the sandbox.
async function sweep(state, escapes) {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id == null) continue;
    const action = sweepAction(state, tab, VIEWER, escapes.get(tab.id) ?? null);
    if (!action) continue;
    try {
      await chrome.tabs.update(tab.id, { url: action.url });
    } catch {
      // tab may be gone / not updatable (e.g. devtools) — skip
    }
  }
}

// --- escape hatches -------------------------------------------------------
// The DNR session rule is the enforcement; this mirror exists so the sweep can
// see the grant (a rule's regexFilter can't be read back as an entry). Same
// lifetime: storage.session dies with the browser session, both are dropped
// when the tab closes.
const ESCAPE_PREFIX = 'escape:';
const ESCAPE_KEY = (tabId) => ESCAPE_PREFIX + tabId;

async function escapeGrants() {
  const map = new Map();
  for (const [k, entry] of Object.entries(await chrome.storage.session.get(null)))
    if (k.startsWith(ESCAPE_PREFIX)) map.set(Number(k.slice(ESCAPE_PREFIX.length)), entry);
  return map;
}

// --- toolbar badge: per-tab disposition (2.4) -----------------------------
async function updateBadge(tabId, url, state) {
  const sandboxed = viewerTarget(url ?? '', VIEWER) !== null;
  try {
    await chrome.action.setBadgeText({ tabId, text: state.active ? (sandboxed ? 'S' : '') : 'off' });
    if (sandboxed) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#44cc88' });
  } catch {}
}

async function refreshBadges(state) {
  for (const tab of await chrome.tabs.query({}))
    if (tab.id != null) await updateBadge(tab.id, tabUrl(tab), state);
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'loading')
    await updateBadge(tabId, tabUrl(tab), await getState());
});

// Escape hatch: the popup asks to reopen a tab's URL natively. Session+tab-
// scoped allow rule (dies with the browser session, removed on tab close),
// then the tab navigates for real.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'open-natively') return false;
  (async () => {
    // Only the popup (real browser chrome) may trigger this — it names the
    // tab it inspected. In-viewer callers are deliberately not supported:
    // nested content must never be one click away from going native.
    const tabId = msg.tabId;
    let entry = null;
    let url = null;
    try {
      const u = new URL(msg.url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        url = u.href;
        entry = normalizeEntry(u.hostname);
      }
    } catch {}
    if (tabId == null || !entry) return sendResponse({ ok: false });
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [escapeRuleId(tabId)],
      addRules: [escapeSessionRule(tabId, entry)],
    });
    // Before navigating: the next reconcile's sweep must already see the grant.
    await chrome.storage.session.set({ [ESCAPE_KEY(tabId)]: entry });
    await chrome.tabs.update(tabId, { url });
    sendResponse({ ok: true });
  })();
  return true; // keep the message channel open for the async response
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [escapeRuleId(tabId)] })
    .catch(() => {});
  chrome.storage.session.remove(ESCAPE_KEY(tabId)).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => applyState());
chrome.runtime.onStartup.addListener(() => applyState());
chrome.storage.onChanged.addListener((_, area) => {
  if (area === 'sync') applyState();
});
// Any other wake-up: reconciling is idempotent and cheap.
applyState();
