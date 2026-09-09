// Observational webRequest capture for bridge fetches (notes/bridge-probe.md
// decisions 1–2). fetch() cannot see Set-Cookie at all, and redirect:'error'
// rejects without exposing the 3xx — but onHeadersReceived (with
// ['responseHeaders'] + Chrome's 'extraHeaders') delivers status, Location,
// and every Set-Cookie (incl. HttpOnly) before the abort. We record per-URL
// FIFO queues (URL-keyed correlation is correct for the jar; FIFO covers
// concurrent same-URL requests) and the bridge takes exactly one entry per
// fetch.
//
// Redirects: a server 3xx is captured at onHeadersReceived (the only event
// Firefox fires for a redirect:'error' fetch). Chrome also fires
// onBeforeRedirect for it, with the resolved redirectUrl — authoritative, so
// it overwrites that entry's Location — and onBeforeRedirect is the ONLY
// event for redirects the network stack synthesizes without response headers
// (HSTS upgrade of e.g. http://wikipedia.org/ — a 307 with no server in the
// loop; DNR redirect rules likewise): those are pushed from there.
//
// Browser differences, all feature-detected here: `details.initiator`
// (Chrome) vs `details.originUrl` (Firefox) name the requesting page;
// 'extraHeaders' exists on Chrome only (Firefox rejects it, and shows
// Set-Cookie without it); onBeforeRedirect never fires on Firefox for a
// SERVER redirect under redirect:'error'. Two more Firefox shapes (verified
// 2026-09-09, Firefox 155):
//  - repeated headers arrive as ONE value joined with "\n" (every Set-Cookie
//    of a response in a single string); the engine rejects a header value
//    with a newline outright ("Response contained invalid HTTP headers"), so
//    values are split back into one entry per line;
//  - a stack-synthesized redirect (HSTS upgrade of http://host/ from a
//    Strict-Transport-Security seen earlier) fires onBeforeRedirect with
//    statusCode 0 and then the SAME request carries on to the target inside
//    the same fetch, redirect:'error' notwithstanding. It is recorded as the
//    307 Chrome reports for the same thing, and the continuation's events
//    are dropped: the bridge reports the hop and the engine re-issues the
//    target as its own request, so the jar and every origin decision see the
//    URL that was really loaded (bridge.mjs takes the same entry whether the
//    fetch then rejected or resolved).

// Statuses fetch treats as a redirect (a 3xx without a parseable Location is
// delivered as an ordinary response instead, and only onHeadersReceived fires).
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

// Backstop for entries nobody claims (see #sweep).
const MAX_ENTRY_AGE_MS = 30_000;
const SWEEP_INTERVAL_MS = 5_000;

// webRequest reports the URL Chromium normalized (default port dropped, dot
// segments resolved, spaces and non-ASCII percent-encoded); the engine hands
// the bridge whatever string it has. Key both sides on the WHATWG form so
// they agree — a mismatch silently drops Set-Cookie and turns a redirect into
// a network failure.
const keyOf = (url) => {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};

export class RedirectCapture {
  #queues = new Map(); // key -> [{at, entry: {status, headers: [[k,v],...]}}]
  #waiters = new Map(); // key -> [resolve, ...]
  #redirects = new Map(); // requestId -> {at, entry} awaiting onBeforeRedirect (Chrome)
  #continued = new Map(); // requestId -> at: synthesized redirect the browser followed itself (Firefox)
  #listeners = null;
  #lastSweep = 0;

  /** @param {{maxAgeMs?: number, sweepIntervalMs?: number}} [opts] tests only */
  constructor(opts = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? MAX_ENTRY_AGE_MS;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  }

  /** @param {string} origin only requests initiated by this origin are kept */
  start(origin, chromeApi = globalThis.chrome) {
    // Firefox joins repeated headers with "\n" (see header); one entry per line.
    const lines = (v) => (v.includes('\n') ? v.split('\n').map((s) => s.trim()).filter(Boolean) : [v]);
    const headersOf = (details) =>
      (details.responseHeaders ?? []).flatMap((h) =>
        lines(String(h.value ?? '')).map((v) => [h.name.toLowerCase(), v]),
      );
    const push = (url, entry) => {
      const key = keyOf(url);
      this.#sweep();
      const w = this.#waiters.get(key);
      if (w?.length) return void w.shift()(entry);
      const q = this.#queues.get(key);
      if (q) q.push({ at: performance.now(), entry });
      else this.#queues.set(key, [{ at: performance.now(), entry }]);
    };
    // Prefix, not URL.origin: extension schemes are non-special, and
    // `new URL('moz-extension://x/').origin` is "null" outside the browser.
    const ours = (details) => {
      if (details.initiator !== undefined) return details.initiator === origin;
      const from = details.originUrl ?? details.documentUrl;
      return typeof from === 'string' && (from === origin || from.startsWith(origin + '/'));
    };
    // Server redirects captured at onHeadersReceived, remembered per request
    // so Chrome's onBeforeRedirect can fix up the Location (see header).
    const redirects = this.#redirects;
    const continued = this.#continued;
    const onHeadersReceived = (details) => {
      if (!ours(details) || continued.has(details.requestId)) return;
      const headers = headersOf(details);
      const entry = { status: details.statusCode, headers };
      if (REDIRECT_STATUS.has(details.statusCode) && headers.some(([k]) => k === 'location'))
        redirects.set(details.requestId, { at: performance.now(), entry });
      push(details.url, entry);
    };
    const onBeforeRedirect = (details) => {
      if (!ours(details) || continued.has(details.requestId)) return;
      // redirectUrl is authoritative (absolute, post-DNR) and is the only
      // Location a stack-synthesized redirect has.
      const seen = redirects.get(details.requestId);
      if (seen) {
        redirects.delete(details.requestId);
        const i = seen.entry.headers.findIndex(([k]) => k === 'location');
        if (i >= 0) seen.entry.headers[i] = ['location', details.redirectUrl];
        else seen.entry.headers.push(['location', details.redirectUrl]);
        return;
      }
      // Stack-synthesized: Chrome says 307 "Internal Redirect", Firefox says 0
      // and keeps going under the same requestId (see header).
      const headers = headersOf(details).filter(([k]) => k !== 'location');
      headers.push(['location', details.redirectUrl]);
      continued.set(details.requestId, performance.now());
      push(details.url, { status: details.statusCode || 307, headers });
    };
    const filter = { urls: ['http://*/*', 'https://*/*'], types: ['xmlhttprequest'] };
    // Chrome hides Set-Cookie unless 'extraHeaders' is asked for; Firefox
    // has no such option (it rejects the string) and shows it regardless.
    const extra = chromeApi.webRequest.OnHeadersReceivedOptions?.EXTRA_HEADERS ? ['extraHeaders'] : [];
    chromeApi.webRequest.onHeadersReceived.addListener(onHeadersReceived, filter, [
      'responseHeaders',
      ...extra,
    ]);
    chromeApi.webRequest.onBeforeRedirect.addListener(onBeforeRedirect, filter, [
      'responseHeaders',
      ...extra,
    ]);
    this.#listeners = { onHeadersReceived, onBeforeRedirect };
    this.chromeApi = chromeApi;
  }

  stop() {
    if (this.#listeners) {
      const wr = this.chromeApi.webRequest;
      wr.onHeadersReceived.removeListener(this.#listeners.onHeadersReceived);
      wr.onBeforeRedirect.removeListener(this.#listeners.onBeforeRedirect);
    }
    this.#listeners = null;
    this.#queues.clear();
    this.#waiters.clear();
    this.#redirects.clear();
    this.#continued.clear();
  }

  /**
   * Take the next captured entry for `url`, waiting up to timeoutMs (event
   * delivery can trail the fetch promise). Resolves null on timeout.
   * @returns {Promise<{status: number, headers: [string,string][]} | null>}
   */
  take(url, timeoutMs = 800) {
    const key = keyOf(url);
    const q = this.#queues.get(key);
    if (q?.length) {
      const { entry } = q.shift();
      if (!q.length) this.#queues.delete(key);
      return Promise.resolve(entry);
    }
    return new Promise((resolve) => {
      let waiters = this.#waiters.get(key);
      if (!waiters) this.#waiters.set(key, (waiters = []));
      const timer = setTimeout(() => {
        const i = waiters.indexOf(wrapped);
        if (i >= 0) waiters.splice(i, 1);
        if (!waiters.length) this.#waiters.delete(key);
        resolve(null);
      }, timeoutMs);
      const wrapped = (entry) => {
        clearTimeout(timer);
        resolve(entry);
      };
      waiters.push(wrapped);
    });
  }

  /**
   * Drop the entry a finished request never claimed (cancelled between the
   * webRequest event and the bridge's take), now or whenever it arrives.
   * Otherwise it would be handed to the NEXT fetch of the same URL — stale
   * Set-Cookie into the engine jar, or a stale 3xx read as a redirect.
   */
  discard(url, timeoutMs = 800) {
    void this.take(url, timeoutMs);
  }

  /** Queued-but-unclaimed entry count (tests/diagnostics). */
  pending() {
    let n = 0;
    for (const q of this.#queues.values()) n += q.length;
    return n;
  }

  // Nothing should sit in a queue for long: every bridge fetch claims or
  // discards its entry. This is the backstop for whatever we didn't think of
  // — bounded memory beats a permanently skewed queue.
  #sweep() {
    const now = performance.now();
    if (now - this.#lastSweep < this.sweepIntervalMs) return;
    this.#lastSweep = now;
    for (const [key, q] of this.#queues) {
      const fresh = q.filter((e) => now - e.at < this.maxAgeMs);
      if (fresh.length) this.#queues.set(key, fresh);
      else this.#queues.delete(key);
    }
    for (const [id, r] of this.#redirects) if (now - r.at >= this.maxAgeMs) this.#redirects.delete(id);
    for (const [id, at] of this.#continued) if (now - at >= this.maxAgeMs) this.#continued.delete(id);
  }
}

// Pull every set-cookie value out of a captured header list.
export function setCookiesOf(entry) {
  return entry.headers.filter(([k]) => k === 'set-cookie').map(([, v]) => v);
}

// A captured entry that describes a redirect the engine must follow itself.
export function isRedirectEntry(entry) {
  return (
    !!entry && entry.status >= 300 && entry.status < 400 && entry.headers.some(([k]) => k === 'location')
  );
}
