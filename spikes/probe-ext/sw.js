// Minimal MV3 service worker. Interception must not depend on this being
// awake (static DNR rules) — spike 0.3 verifies exactly that.
chrome.runtime.onInstalled.addListener(() => {
  console.log('bs-probe installed');
});
