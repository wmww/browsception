// MV3 event page (Firefox has no extension service workers). Probe 7 audits
// what exists here; probe 3 checks a top-level webRequest listener survives
// event-page suspension.
const audit = {
  hasChrome: typeof chrome !== 'undefined',
  hasBrowser: typeof browser !== 'undefined',
  globalThisName: Object.prototype.toString.call(globalThis),
  selfRegistration: typeof self !== 'undefined' && 'registration' in self,
  clients: typeof clients !== 'undefined',
  alarms: typeof chrome !== 'undefined' && !!chrome.alarms,
  dnr: typeof chrome?.declarativeNetRequest,
  storageSession: typeof chrome?.storage?.session,
  tabsQuery: typeof chrome?.tabs?.query,
  tabsUpdate: typeof chrome?.tabs?.update,
  runtimeOnMessage: typeof chrome?.runtime?.onMessage,
  actionSetBadgeText: typeof chrome?.action?.setBadgeText,
  documentPresent: typeof document !== 'undefined',
  windowPresent: typeof window !== 'undefined',
  loadedAt: Date.now(),
  promiseReturning: {},
};

// Promise-returning check for the chrome.* namespace (no callback given).
try {
  const p = chrome.tabs.query({});
  audit.promiseReturning.tabsQuery = p instanceof Promise;
  p.catch(() => {});
} catch (e) {
  audit.promiseReturning.tabsQuery = `throws: ${e.message}`;
}
try {
  const p = chrome.declarativeNetRequest.getDynamicRules();
  audit.promiseReturning.dnrGetDynamicRules = p instanceof Promise;
  p.catch(() => {});
} catch (e) {
  audit.promiseReturning.dnrGetDynamicRules = `throws: ${e.message}`;
}
try {
  const p = chrome.storage.session?.set({ bgAudit: 1 });
  audit.promiseReturning.storageSessionSet = p instanceof Promise;
  p?.catch?.((e) => (audit.storageSessionError = String(e)));
} catch (e) {
  audit.promiseReturning.storageSessionSet = `throws: ${e.message}`;
}
try {
  const p = chrome.action?.setBadgeText({ text: 'ff' });
  audit.promiseReturning.actionSetBadgeText = p instanceof Promise;
  p?.catch?.((e) => (audit.setBadgeError = String(e)));
} catch (e) {
  audit.promiseReturning.actionSetBadgeText = `throws: ${e.message}`;
}

// webRequest listener registered at top level, persisted in storage.local so
// the viewer can read it even after this page was suspended and restarted.
const bgEvents = [];
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    bgEvents.push({ url: d.url, status: d.statusCode, loadedAt: audit.loadedAt, at: Date.now() });
    chrome.storage.local.set({ bgEvents });
  },
  { urls: ['https://*.bstest/*'], types: ['xmlhttprequest'] },
  ['responseHeaders'],
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg === 'audit') sendResponse(audit);
  else if (msg === 'bgEvents') sendResponse(bgEvents);
  return true;
});

chrome.runtime.onInstalled.addListener(() => console.log('ff-probe installed'));
