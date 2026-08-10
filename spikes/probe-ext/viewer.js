// Probe surface for spikes 0.2/0.3 and headless-parity checks. Tests drive
// these via playwright evaluate(); everything returns plain JSON.

// The intercepted URL rides ?url=<raw, unencoded>. URLSearchParams would
// truncate at '&' in the target URL — slice at the first "url=" instead.
function interceptedUrl() {
  const i = location.search.indexOf('url=');
  return i < 0 ? null : location.search.slice(i + 4);
}
document.getElementById('url').textContent = interceptedUrl() ?? '(none)';
document.title = `bs-probe: ${interceptedUrl() ?? 'idle'}`;

globalThis.__probe = {
  interceptedUrl,

  // --- isolation / threading preconditions (open-questions #19, spike 0.2) ---
  async isolation() {
    const out = { crossOriginIsolated: globalThis.crossOriginIsolated === true };
    try {
      out.sabOk = new SharedArrayBuffer(64).byteLength === 64;
    } catch {
      out.sabOk = false;
    }
    try {
      out.wasmSharedMemOk =
        new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }).buffer instanceof
        SharedArrayBuffer;
    } catch {
      out.wasmSharedMemOk = false;
    }
    // Worker + Atomics round-trip: worker stores 42 and notifies.
    out.workerAtomicsOk = await new Promise((resolve) => {
      try {
        const sab = new SharedArrayBuffer(8);
        const arr = new Int32Array(sab);
        const w = new Worker('worker.js');
        const timeout = setTimeout(() => resolve(false), 3000);
        w.onmessage = () => {
          clearTimeout(timeout);
          w.terminate();
          resolve(Atomics.load(arr, 0) === 42);
        };
        w.postMessage(sab);
      } catch {
        resolve(false);
      }
    });
    return out;
  },

  // --- fetch semantics (spike 0.2: open-questions #1, #2) ---
  async fetchProbe(url, init = {}) {
    try {
      const r = await fetch(url, { credentials: 'omit', ...init });
      let bodyPrefix = null;
      try {
        bodyPrefix = (await r.clone().text()).slice(0, 200);
      } catch {}
      return {
        ok: r.ok,
        status: r.status,
        type: r.type,
        redirected: r.redirected,
        url: r.url,
        headers: [...r.headers.entries()],
        getSetCookie: typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : null,
        bodyPrefix,
      };
    } catch (e) {
      return { error: String(e) };
    }
  },

  async manualRedirect(url) {
    try {
      const r = await fetch(url, { redirect: 'manual', credentials: 'omit' });
      return {
        type: r.type, // 'opaqueredirect' would mean status/Location are hidden
        status: r.status,
        location: r.headers.get('location'),
        headers: [...r.headers.entries()],
      };
    } catch (e) {
      return { error: String(e) };
    }
  },

  // --- DNR manipulation (spikes 0.2 header rules, 0.3 interception) ---
  dnr: {
    updateDynamicRules: (opts) => chrome.declarativeNetRequest.updateDynamicRules(opts),
    getDynamicRules: () => chrome.declarativeNetRequest.getDynamicRules(),
    updateSessionRules: (opts) => chrome.declarativeNetRequest.updateSessionRules(opts),
    getSessionRules: () => chrome.declarativeNetRequest.getSessionRules(),
    updateEnabledRulesets: (opts) => chrome.declarativeNetRequest.updateEnabledRulesets(opts),
    getEnabledRulesets: () => chrome.declarativeNetRequest.getEnabledRulesets(),
  },

  tabId: () => new Promise((r) => chrome.tabs?.getCurrent((t) => r(t?.id ?? null))),

  // --- observational webRequest capture (spike 0.2: Set-Cookie + redirect
  // chain fallback, since fetch exposes neither) ---
  wrEvents: [],
  wrStart(urls = ['https://*.bstest/*']) {
    const rec = (name) => (details) => {
      globalThis.__probe.wrEvents.push({
        event: name,
        requestId: details.requestId,
        url: details.url,
        method: details.method,
        type: details.type,
        statusCode: details.statusCode,
        redirectUrl: details.redirectUrl,
        requestHeaders: details.requestHeaders,
        responseHeaders: details.responseHeaders,
      });
    };
    const filter = { urls, types: ['xmlhttprequest'] };
    chrome.webRequest.onSendHeaders.addListener(rec('onSendHeaders'), filter, [
      'requestHeaders',
      'extraHeaders',
    ]);
    chrome.webRequest.onBeforeRedirect.addListener(rec('onBeforeRedirect'), filter, [
      'responseHeaders',
      'extraHeaders',
    ]);
    chrome.webRequest.onHeadersReceived.addListener(rec('onHeadersReceived'), filter, [
      'responseHeaders',
      'extraHeaders',
    ]);
    chrome.webRequest.onCompleted.addListener(rec('onCompleted'), filter, [
      'responseHeaders',
      'extraHeaders',
    ]);
    return true;
  },
  wrDump() {
    return globalThis.__probe.wrEvents;
  },
};

// redirect:'error' probe — does webRequest still capture the 3xx headers?
globalThis.__probe.wrStartErrors = function () {
  chrome.webRequest.onErrorOccurred.addListener(
    (d) => globalThis.__probe.wrEvents.push({ event: 'onErrorOccurred', requestId: d.requestId, url: d.url, error: d.error }),
    { urls: ['https://*.bstest/*'], types: ['xmlhttprequest'] },
  );
  return true;
};
