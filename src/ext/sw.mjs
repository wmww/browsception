// Background service worker (2.2): owns activation/mode/list state
// (storage.sync) and applies it declaratively to DNR. Interception itself
// never depends on this worker being awake — the rules persist (static
// ruleset toggle + dynamic rules); the SW only reconciles state changes.
//
// Also sweeps already-open tabs whose URL should be sandboxed: covers the
// install/startup first-navigation race (issues/) and makes list edits apply
// to open tabs. The page's JS has already run by sweep time — the redirect
// closes the exposure window, it cannot un-execute anything.

import { desiredRuleState, shouldSandbox, CATCHALL_RULESET_ID } from './dnr-rules.mjs';

const VIEWER = chrome.runtime.getURL('ext/viewer.html');

// Shipped default: active, blacklist mode (native-by-default). 2.6 flips the
// default to whitelist mode once 2.5's guard-rail suite is green.
const DEFAULTS = { active: true, mode: 'blacklist', whitelist: [], blacklist: [] };

async function getState() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
}

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
}

async function sweep(state) {
  for (const tab of await chrome.tabs.query({})) {
    const url = tab.url ?? tab.pendingUrl ?? '';
    if (tab.id == null || !shouldSandbox(state, url)) continue;
    try {
      // Raw ?url= mirrors the DNR redirect's un-encoded \0 contract.
      await chrome.tabs.update(tab.id, { url: `${VIEWER}?url=${url}` });
    } catch {
      // tab may be gone / not updatable (e.g. devtools) — skip
    }
  }
}

chrome.runtime.onInstalled.addListener(() => applyState());
chrome.runtime.onStartup.addListener(() => applyState());
chrome.storage.onChanged.addListener((_, area) => {
  if (area === 'sync') applyState();
});
// Any other wake-up: reconciling is idempotent and cheap.
applyState();
