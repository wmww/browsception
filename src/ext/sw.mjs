// Background service worker (2.2): owns activation/mode/list state
// (storage.sync) and applies it declaratively to DNR. Interception itself
// never depends on this worker being awake — the rules persist (static
// ruleset toggle + dynamic rules); the SW only reconciles state changes.
//
// Also sweeps already-open tabs whose URL should be sandboxed: covers the
// install/startup first-navigation race (issues/) and makes list edits apply
// to open tabs. The page's JS has already run by sweep time — the redirect
// closes the exposure window, it cannot un-execute anything.

import {
  desiredRuleState,
  shouldSandbox,
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

  await sweep(state);
  await refreshBadges(state);
}

// Target URL of a viewer tab, or null (raw ?url= slice — see viewer.mjs).
function viewerTarget(url) {
  if (!url.startsWith(`${VIEWER}?`)) return null;
  const i = url.indexOf('url=');
  return i < 0 ? null : url.slice(i + 4);
}

// SYMMETRIC sweep (ui.md § toggle/edit behavior): state changes apply to
// open tabs in both directions — native tabs that should now be sandboxed
// redirect into a viewer, and viewer tabs whose target is now native leave
// the sandbox. (Also covers the install/startup first-navigation race.)
async function sweep(state) {
  for (const tab of await chrome.tabs.query({})) {
    const url = tab.url ?? tab.pendingUrl ?? '';
    if (tab.id == null) continue;
    const target = viewerTarget(url);
    try {
      if (target !== null && !shouldSandbox(state, target))
        await chrome.tabs.update(tab.id, { url: target });
      else if (target === null && shouldSandbox(state, url))
        // Raw ?url= mirrors the DNR redirect's un-encoded \0 contract.
        await chrome.tabs.update(tab.id, { url: `${VIEWER}?url=${url}` });
    } catch {
      // tab may be gone / not updatable (e.g. devtools) — skip
    }
  }
}

// --- toolbar badge: per-tab disposition (2.4) -----------------------------
async function updateBadge(tabId, url, state) {
  const sandboxed = viewerTarget(url ?? '') !== null;
  try {
    await chrome.action.setBadgeText({ tabId, text: state.active ? (sandboxed ? 'S' : '') : 'off' });
    if (sandboxed) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#44cc88' });
  } catch {}
}

async function refreshBadges(state) {
  for (const tab of await chrome.tabs.query({}))
    if (tab.id != null) await updateBadge(tab.id, tab.url ?? tab.pendingUrl ?? '', state);
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'loading')
    await updateBadge(tabId, tab.url ?? tab.pendingUrl ?? '', await getState());
});

// 2.3 escape hatch: the viewer asks to reopen its current URL natively in
// this tab. Session+tab-scoped allow rule (dies with the browser session,
// removed on tab close), then the tab navigates for real.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'open-natively') return false;
  (async () => {
    // sender.tab for viewer-initiated requests; msg.tabId for the popup
    // (real browser chrome — allowed to act on the tab it inspected).
    const tabId = sender.tab?.id ?? msg.tabId;
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
    await chrome.tabs.update(tabId, { url });
    sendResponse({ ok: true });
  })();
  return true; // keep the message channel open for the async response
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [escapeRuleId(tabId)] })
    .catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => applyState());
chrome.runtime.onStartup.addListener(() => applyState());
chrome.storage.onChanged.addListener((_, area) => {
  if (area === 'sync') applyState();
});
// Any other wake-up: reconciling is idempotent and cheap.
applyState();
